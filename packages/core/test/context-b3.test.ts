import { describe, expect, it } from "vitest";
import { estimateTokens } from "@kcode/shared";
import type { ChatMessage, Tool } from "@kcode/contracts";
import { DEFAULT_BUDGET, capToolResult, contextWindowFor, deriveBudget } from "../src/context/budget.js";
import { COMPACTION_KEEP_TAIL, planCompaction } from "../src/context/compact.js";
import { AgentLoop } from "../src/core/loop.js";
import {
  InMemoryToolRegistry,
  MemoryAudit,
  MemorySink,
  ScriptedLLM,
  allowAll,
  noHooks,
} from "../src/testing/index.js";

describe("B3：token 估算与预算派生", () => {
  it("CJK 感知估算：中文 ~0.75 tok/字，西文 ~3.8 字符/tok", () => {
    expect(estimateTokens("一二三四五")).toBe(4); // 5 * 0.75 = 3.75 → 4
    expect(estimateTokens("abcdefghij")).toBe(3); // 10 / 3.8 = 2.6 → 3
    // 纯中文不再按长度/3 高估
    expect(estimateTokens("字".repeat(100))).toBeLessThan(100);
  });

  it("模型窗口提示表：deepseek-v4 1M、glm 128k、未识别回退 128k", () => {
    expect(contextWindowFor("deepseek/deepseek-v4-pro")).toBe(1_000_000);
    expect(contextWindowFor("glm/glm-5.3")).toBe(128_000);
    expect(contextWindowFor("unknown/model-x")).toBe(128_000);
  });

  it("预算派生（对齐批修订）：history = 窗口 − 绝对预留（输出 21k + 缓冲 13k）", () => {
    expect(deriveBudget(1_000_000).history).toBe(966_000); // 97%——大窗晚压
    expect(deriveBudget(200_000).history).toBe(166_000); // 83%——zcode 同区间
    expect(deriveBudget(128_000).history).toBe(94_000); // 73%
    // 极小窗口守卫：预留封顶一半
    expect(deriveBudget(50_000).history).toBe(25_000);
  });

  it("micro 截断：超 toolResult 预算截头尾并标记；未超原样", () => {
    const big = "x".repeat(200_000);
    const capped = capToolResult(big, DEFAULT_BUDGET.toolResult);
    expect(capped.length).toBeLessThan(big.length);
    expect(capped).toContain("已截断");
    expect(capped.startsWith("xxxx")).toBe(true);
    expect(capped.endsWith("xxxx")).toBe(true);
    const small = "short";
    expect(capToolResult(small, DEFAULT_BUDGET.toolResult)).toBe(small);
  });
});

describe("B3：loop 集成", () => {
  const dump: Tool = {
    definition: {
      name: "dump",
      description: "输出内容",
      parameters: { type: "object" },
      readOnly: false,
    },
    execute: async (input) => {
      const { size } = input as { size?: number };
      return { ok: true, output: "x".repeat(size ?? 10) };
    },
  };

  it("工具结果回灌历史被 micro 截断（发给模型的副本），事件保持全文", async () => {
    const llm = new ScriptedLLM([
      { toolCalls: [{ callId: "c1", tool: "dump", args: { size: 200_000 } }] },
      { text: "done" },
    ]);
    const sink = new MemorySink();
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([dump]),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
      },
      { sessionId: "sess_b3a", model: "m", systemPrompt: "t", now: () => 0 },
    );
    await loop.run("大输出");
    const toolMsg = llm.requests[1]!.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("已截断");
    const event = sink.events.find((e) => e.type === "tool_result");
    expect(event && "output" in event ? event.output.length : 0).toBe(200_000);
  });

  it("pinAnchor + compactNow：手动压缩保留任务锚点、计划锚点与近期 N 条", async () => {
    const llm = new ScriptedLLM([
      { text: "一" },
      { text: "二" },
      { text: "三" },
      { text: "四" },
      { text: "五" },
      { text: "六" },
    ]);
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([]),
        permissions: allowAll,
        hooks: noHooks,
        sink: new MemorySink(),
        audit: new MemoryAudit().sink,
        summarizer: { summarize: async () => "【摘要】早期对话已折叠。" },
      },
      { sessionId: "sess_b3b", model: "m", systemPrompt: "t", now: () => 0 },
    );
    loop.pinAnchor("【已批准的执行计划】\n1. 改 A");
    for (const q of ["q1", "q2", "q3", "q4", "q5", "q6"]) {
      await loop.run(q);
    }
    const result = await loop.compactNow();
    expect(result).not.toBeNull();
    expect(result?.dropped).toBeGreaterThan(0);
    // 压缩后的下一次请求：锚点齐备
    const stats = loop.contextStats();
    expect(stats.pinnedAnchor).toBe(true);
    expect(stats.historyBudget).toBe(94_000); // 默认 128k 窗口派生（128k−34k 预留）
    expect(stats.historyTokens).toBeLessThan(2000);
  });

  it("保留区为 10 条（KEEP_TAIL 升级）", () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      role: "user" as const,
      content: `msg-${i}`,
    }));
    const plan = planCompaction(history, { ...DEFAULT_BUDGET, history: 1 }, true);
    expect(plan?.keepTail.length).toBe(COMPACTION_KEEP_TAIL);
    expect(COMPACTION_KEEP_TAIL).toBe(10);
  });

  it("压缩切分不拆调用组：保留区起点回退到 assistant 调用，无孤立 tool result", () => {
    const history: ChatMessage[] = [{ role: "user", content: "任务" }];
    // 4 组「assistant(toolCalls) + 两个 tool 结果」，共 13 条；默认起点 13-10=3 恰好落在 tool 上
    for (let i = 1; i <= 4; i++) {
      history.push({ role: "assistant", content: "", toolCalls: [{ callId: `c${i}`, tool: "t", args: {} }] });
      history.push({ role: "tool", content: `r${i}a`, toolCallId: `c${i}`, name: "t" });
      history.push({ role: "tool", content: `r${i}b`, toolCallId: `c${i}`, name: "t" });
    }
    const plan = planCompaction(history, { ...DEFAULT_BUDGET, history: 1 }, true);
    expect(plan).not.toBeNull();
    // 保留区起点不得是 tool（否则其 assistant(toolCalls) 被拆到待摘要区，形成孤立结果）
    expect(plan!.keepTail[0]?.role).not.toBe("tool");
    expect(plan!.keepTail[0]).toMatchObject({ role: "assistant" });
  });

  it("历史过短（≤ 保留区）时返回 null：不制造孤立 tool result", () => {
    const history: ChatMessage[] = [{ role: "user", content: "任务" }];
    for (let i = 1; i <= 3; i++) {
      history.push({ role: "assistant", content: "", toolCalls: [{ callId: `c${i}`, tool: "t", args: {} }] });
      history.push({ role: "tool", content: `r${i}`, toolCallId: `c${i}`, name: "t" });
    }
    // 7 条 < 10 条保留区：无法折叠出完整轮次，应返回 null 而非拆组
    expect(planCompaction(history, { ...DEFAULT_BUDGET, history: 1 }, true)).toBeNull();
  });
});

describe("对齐批：provider usage 校准 / 实测触发 / 熔断", () => {
  const basePorts = (llm: ScriptedLLM, summarizer?: { summarize(input: { messages: ChatMessage[] }): Promise<string> }) => ({
    llm,
    tools: new InMemoryToolRegistry([]),
    permissions: allowAll,
    hooks: noHooks,
    sink: new MemorySink(),
    audit: new MemoryAudit().sink,
    ...(summarizer !== undefined ? { summarizer } : {}),
  });

  it("provider usage 校准：contextStats = 最近回报输入量 + 其后增量估算", async () => {
    const llm = new ScriptedLLM([{ text: "回复正文", usage: { inputTokens: 50_000, outputTokens: 100 } }]);
    const loop = new AgentLoop(basePorts(llm), { sessionId: "s_cal", model: "m", systemPrompt: "t", now: () => 0 });
    await loop.run("问题");
    const stats = loop.contextStats();
    expect(stats.historyTokens).toBeGreaterThanOrEqual(50_000);
    expect(stats.historyTokens).toBeLessThan(50_050); // 增量只有 assistant 回复的估算
    // 无 usage 的后续轮：校准仍生效并叠加增量
    const llm2 = new ScriptedLLM([{ text: "a", usage: { inputTokens: 10_000, outputTokens: 1 } }, { text: "b" }]);
    const loop2 = new AgentLoop(basePorts(llm2), { sessionId: "s_cal2", model: "m", systemPrompt: "t", now: () => 0 });
    await loop2.run("q1");
    await loop2.run("q2");
    const s2 = loop2.contextStats();
    expect(s2.historyTokens).toBeGreaterThanOrEqual(10_000);
    expect(s2.historyTokens).toBeLessThan(10_100);
  });

  it("measuredTokens 触发判定优先于估算：实测超即压、实测未超即不压", () => {
    const history = Array.from({ length: 12 }, (_, i) => ({ role: "user" as const, content: `m${i}` }));
    const wide = { ...DEFAULT_BUDGET, history: 100_000 };
    expect(planCompaction(history, wide, false)).toBeNull(); // 估算远未超
    expect(planCompaction(history, wide, false, 100_001)).not.toBeNull(); // 实测已超
    const tiny = { ...DEFAULT_BUDGET, history: 1 };
    expect(planCompaction(history, tiny, false)).not.toBeNull(); // 估算路径：必超
    expect(planCompaction(history, tiny, false, 0)).toBeNull(); // 实测未超：估算再大也不压
  });

  it("压缩失败隔离与熔断：抛错不打断整轮，连续 3 次失败停手，force 不受熔断且上抛", async () => {
    let calls = 0;
    const boom = {
      summarize: async (): Promise<string> => {
        calls += 1;
        throw new Error("boom");
      },
    };
    const script = ["一", "二", "三", "四", "五", "六", "七", "八"].map((text) => ({ text }));
    const loop = new AgentLoop(basePorts(new ScriptedLLM(script), boom), {
      sessionId: "s_breaker",
      model: "m",
      systemPrompt: "t",
      budget: { system: 4096, history: 1, toolResult: 8192 }, // 必触发
      now: () => 0,
    });
    for (const q of ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"]) {
      await loop.run(q); // 曾几何时会整轮炸——现在静默降级
    }
    expect(calls).toBe(3); // 第 4 次起熔断，summarizer 不再被调
    await expect(loop.compactNow()).rejects.toThrow("boom"); // 手动压缩错误必须可见
  });
});

import { describe, expect, it } from "vitest";
import { estimateTokens } from "@kcode/shared";
import type { Tool } from "@kcode/contracts";
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

  it("预算派生：history = 窗口 60%", () => {
    expect(deriveBudget(1_000_000).history).toBe(600_000);
    expect(deriveBudget(128_000).history).toBe(76_800);
  });

  it("micro 截断：超 toolResult 预算截头尾并标记；未超原样", () => {
    const big = "x".repeat(200_000);
    const capped = capToolResult(big, DEFAULT_BUDGET);
    expect(capped.length).toBeLessThan(big.length);
    expect(capped).toContain("已截断");
    expect(capped.startsWith("xxxx")).toBe(true);
    expect(capped.endsWith("xxxx")).toBe(true);
    const small = "short";
    expect(capToolResult(small, DEFAULT_BUDGET)).toBe(small);
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
    expect(stats.historyBudget).toBe(76_800); // 默认 128k 窗口派生
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
});

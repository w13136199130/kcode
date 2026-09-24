import { describe, expect, it } from "vitest";
import type { SessionEvent, Tool, ToolDefinition } from "@kcode/contracts";
import { DEFAULT_BUDGET } from "../src/context/budget.js";
import { AgentLoop } from "../src/core/loop.js";
import {
  InMemoryToolRegistry,
  MemoryAudit,
  MemorySink,
  ScriptedLLM,
  allowAll,
  denyAll,
  noHooks,
} from "../src/testing/index.js";

type ToolResultEvent = Extract<SessionEvent, { type: "tool_result" }>;

const echoDefinition: ToolDefinition = {
  name: "echo",
  description: "回显消息",
  parameters: { type: "object", properties: { msg: { type: "string" } } },
  readOnly: true,
};

function echoTool(received: string[]): Tool {
  return {
    definition: echoDefinition,
    execute: async (input) => {
      const { msg } = input as { msg: string };
      received.push(msg);
      return { ok: true, output: msg };
    },
  };
}

describe("AgentLoop（§5.1 状态机）", () => {
  it("最后允许轮次得到正文仍是 completed，不误报上限", async () => {
    const sink = new MemorySink();
    const loop = new AgentLoop({ llm: new ScriptedLLM([{ text: "done" }]),
      tools: new InMemoryToolRegistry([]), permissions: allowAll, hooks: noHooks,
      sink, audit: new MemoryAudit().sink,
    }, { sessionId: "last-turn", model: "m", systemPrompt: "t", maxTurns: 1 });
    expect(await loop.run("go")).toMatchObject({ status: "completed", turns: 1 });
    expect(sink.events.some((e) => e.type === "run_limit_reached")).toBe(false);
    expect(sink.events.at(-1)).toMatchObject({ type: "session_end", reason: "completed" });
  });

  it("消息→工具→回填→结束，事件序列符合 JSONL 契约", async () => {
    const llm = new ScriptedLLM([
      {
        toolCalls: [
          { callId: "c1", tool: "echo", args: { msg: "hi" } },
          { callId: "c2", tool: "echo", args: { msg: "yo" } },
        ],
      },
      { text: "done" },
    ]);
    const sink = new MemorySink();
    const audit = new MemoryAudit();
    const received: string[] = [];
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([echoTool(received)]),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: audit.sink,
      },
      { sessionId: "sess_t1", model: "mock-1", systemPrompt: "test", now: () => 0 },
    );

    const summary = await loop.run("echo hi and yo");

    expect(summary).toEqual({ sessionId: "sess_t1", turns: 2, toolCalls: 2, status: "completed" });
    expect(sink.events.map((e) => e.type)).toEqual([
      "session_start",
      "user_message",
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
      "assistant_message",
      "session_end",
    ]);
    expect([...received].sort()).toEqual(["hi", "yo"]);
    expect(audit.records.filter((r) => r.decision === "executed")).toHaveLength(2);
    // 组装产物含稳定区 system 消息与工具清单（§5.2）
    expect(llm.requests[0]?.messages[0]?.role).toBe("system");
    expect(llm.requests[0]?.tools?.map((t) => t.name)).toEqual(["echo"]);
  });

  it("onDelta 收到流式文本增量（瞬态，不落 JSONL）", async () => {
    const llm = new ScriptedLLM([{ textParts: ["Hel", "lo"] }]);
    const sink = new MemorySink();
    const deltas: string[] = [];
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([]),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
        onDelta: (d) => {
          deltas.push(d);
        },
      },
      { sessionId: "sess_delta", model: "mock-1", systemPrompt: "test", now: () => 0 },
    );
    await loop.run("hi");
    expect(deltas.join("")).toBe("Hello");
    expect(sink.events.filter((e) => e.type === "assistant_message")).toHaveLength(1);
  });

  it("run 附图进入历史（多模态输入）；updateSystemPrompt 影响下一轮", async () => {
    const llm = new ScriptedLLM([{ text: "ok1" }, { text: "ok2" }]);
    const sink = new MemorySink();
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([]),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
      },
      { sessionId: "sess_img", model: "m", systemPrompt: "base", now: () => 0 },
    );
    await loop.run("看图", { images: ["C:/tmp/a.png"] });
    const firstRequest = llm.requests[0];
    expect((firstRequest?.messages[1] as { images?: string[] } | undefined)?.images).toEqual([
      "C:/tmp/a.png",
    ]);

    loop.updateSystemPrompt("base + 计划模式");
    await loop.run("再问");
    expect(llm.requests[1]?.messages[0]?.content).toContain("计划模式");
  });

  it("技能自动触发：正文注入动态区并落 skill_used 事件（§5.2）", async () => {
    const llm = new ScriptedLLM([{ text: "ok" }]);
    const sink = new MemorySink();
    const skills = {
      meta: () => [{ name: "code-review", description: "审查代码" }],
      body: async () => "审查步骤：1. 读 diff 2. 逐文件给结论",
      match: (input: string) =>
        input.includes("审查")
          ? [{ name: "code-review", description: "审查代码" }]
          : [],
    };
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([]),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
        skills,
      },
      { sessionId: "sess_skill", model: "m", systemPrompt: "t", now: () => 0 },
    );
    await loop.run("帮我审查一下");
    const request = llm.requests[0];
    const messages = request?.messages ?? [];
    expect(messages[1]?.content).toContain("<skill name=\"code-review\">");
    expect(messages[1]?.content).toContain("审查步骤");
    expect(messages[2]?.content).toBe("帮我审查一下");
    expect(
      sink.events.some((e) => e.type === "skill_used" && e.skill === "code-review"),
    ).toBe(true);
  });

  it("超预算触发模型摘要压缩：摘要与任务锚点进入后续请求", async () => {
    const llm = new ScriptedLLM([
      { toolCalls: [{ callId: "c1", tool: "dump", args: {} }] },
      { toolCalls: [{ callId: "c2", tool: "dump", args: {} }] },
      { toolCalls: [{ callId: "c3", tool: "dump", args: {} }] },
      { text: "首轮完成" },
      { text: "第二轮回答" },
    ]);
    const dump: Tool = {
      definition: {
        name: "dump",
        description: "输出大段内容",
        parameters: { type: "object" },
        readOnly: false,
      },
      execute: async () => ({ ok: true, output: "y".repeat(8000) }),
    };
    const summarized: number[] = [];
    const sink = new MemorySink();
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([dump]),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
        summarizer: {
          summarize: async (input) => {
            summarized.push(input.messages.length);
            return "【摘要】任务=验证压缩；已读取三个大文件，内容无异常。";
          },
        },
      },
      {
        sessionId: "sess_compact",
        model: "m",
        systemPrompt: "t",
        now: () => 0,
        budget: { ...DEFAULT_BUDGET, history: 100 },
      },
    );
    await loop.run("开始任务：保持目标");
    await loop.run("第二问");

    const event = sink.events.find((e) => e.type === "compaction_summary");
    expect(event && "summary" in event ? event.summary : "").toContain("【摘要】");
    expect(summarized.length).toBeGreaterThanOrEqual(1);
    // 第二次提问的请求是最后一次：压缩后的历史里应同时有任务锚点与摘要
    const second = llm.requests[llm.requests.length - 1]?.messages ?? [];
    expect(second.some((m) => m.content === "开始任务：保持目标")).toBe(true);
    expect(second.some((m) => m.content.includes("任务=验证压缩"))).toBe(true);
  });

  it("权限 deny：工具不执行、留审计、结果标记失败", async () => {
    const llm = new ScriptedLLM([
      { toolCalls: [{ callId: "c1", tool: "echo", args: { msg: "nope" } }] },
      { text: "stopped" },
    ]);
    const sink = new MemorySink();
    const audit = new MemoryAudit();
    const received: string[] = [];
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([echoTool(received)]),
        permissions: denyAll,
        hooks: noHooks,
        sink,
        audit: audit.sink,
      },
      { sessionId: "sess_t2", model: "mock-1", systemPrompt: "test", now: () => 0 },
    );

    await loop.run("try echo");

    expect(received).toEqual([]);
    const resultEvent = sink.events.find(
      (e): e is ToolResultEvent => e.type === "tool_result",
    );
    expect(resultEvent?.ok).toBe(false);
    expect(resultEvent?.error).toContain("permission denied");
    expect(audit.records.some((r) => r.decision === "deny")).toBe(true);
  });

  it("权限决策落盘：deny 与 ask 应答生成 permission_decision 事件；工具结果带耗时", async () => {
    const askEngine = {
      decide: async (): Promise<"ask"> => "ask",
    };
    const llm = new ScriptedLLM([
      {
        toolCalls: [
          { callId: "c1", tool: "echo", args: { msg: "one" } },
          { callId: "c2", tool: "echo", args: { msg: "two" } },
        ],
      },
      { text: "done" },
    ]);
    const sink = new MemorySink();
    const received: string[] = [];
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([echoTool(received)]),
        permissions: askEngine,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
        asker: {
          confirm: async (call) =>
            call.callId === "c1" ? { allowed: true, scope: "session" } : false,
        },
      },
      { sessionId: "sess_perm1", model: "mock-1", systemPrompt: "t", now: () => 0 },
    );
    await loop.run("go");

    const decisions = sink.events.filter(
      (e): e is Extract<SessionEvent, { type: "permission_decision" }> =>
        e.type === "permission_decision",
    );
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({
      type: "permission_decision",
      callId: "c1",
      tool: "echo",
      decision: "ask-allowed",
      scope: "session",
    });
    expect(decisions[1]).toMatchObject({
      type: "permission_decision",
      callId: "c2",
      tool: "echo",
      decision: "ask-denied",
    });
    // 规则放行不落盘（高频噪声）
    const results = sink.events.filter((e) => e.type === "tool_result");
    for (const r of results) {
      expect(r).toHaveProperty("durationMs");
    }
  });

  it("reasoning：瞬态 onReasoning 推送 + assistant_message 落盘（不回传 API）", async () => {
    const llm = new ScriptedLLM([
      { reasoningParts: ["先查证", "再回答"], text: "结论" },
    ]);
    const sink = new MemorySink();
    const reasoningDeltas: string[] = [];
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([]),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
        onReasoning: (d) => reasoningDeltas.push(d),
      },
      { sessionId: "sess_reason1", model: "m", systemPrompt: "t", now: () => 0 },
    );
    await loop.run("问个问题");
    expect(reasoningDeltas).toEqual(["先查证", "再回答"]);
    const message = sink.events.find((e) => e.type === "assistant_message");
    expect(message).toMatchObject({ type: "assistant_message", content: "结论", reasoning: "先查证再回答" });
    // 思考过程不进请求历史（ChatMessage 无 reasoning 概念）
    const lastRequest = llm.requests[llm.requests.length - 1];
    expect(JSON.stringify(lastRequest?.messages)).not.toContain("先查证");
  });

  it("LLM 调用失败：llm_error 事件可见，不再静默吞掉", async () => {
    const llm = new ScriptedLLM([{ error: "401 Unauthorized：API key 无效" }]);
    const sink = new MemorySink();
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([]),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
      },
      { sessionId: "sess_llmerr", model: "m", systemPrompt: "t", now: () => 0 },
    );
    const summary = await loop.run("问个问题");
    const err = sink.events.find((e) => e.type === "llm_error");
    expect(err).toMatchObject({ type: "llm_error", error: "401 Unauthorized：API key 无效" });
    // 轮次正常收尾（run_done 可达），但无 assistant 内容
    expect(sink.events.some((e) => e.type === "assistant_message")).toBe(false);
    expect(summary.turns).toBe(1);
    expect(summary.status).toBe("failed");
    expect(sink.events.at(-1)).toMatchObject({ type: "session_end", reason: "failed" });
  });

  it("Esc 中断：预置 abort 信号 → 不发起 LLM 调用，session_end(aborted)", async () => {
    const llm = new ScriptedLLM([{ text: "不应被调用" }]);
    const sink = new MemorySink();
    const controller = new AbortController();
    controller.abort();
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([]),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
      },
      { sessionId: "sess_abort1", model: "m", systemPrompt: "t", now: () => 0 },
    );
    await loop.run("做点什么", { signal: controller.signal });
    expect(llm.requests).toHaveLength(0);
    const end = sink.events.find((e) => e.type === "session_end");
    expect(end).toMatchObject({ type: "session_end", reason: "aborted" });
    expect(sink.events.some((e) => e.type === "run_limit_reached")).toBe(false);
  });

  it("轮次上限：到顶发 run_limit_reached，session_end(limit_reached)，历史保留", async () => {
    const echo = echoTool([]);
    const llm = new ScriptedLLM([
      { toolCalls: [{ callId: "c1", tool: "echo", args: { msg: "hi" } }] },
      { toolCalls: [{ callId: "c2", tool: "echo", args: { msg: "again" } }] },
    ]);
    const sink = new MemorySink();
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([echo]),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
      },
      { sessionId: "sess_limit1", model: "m", systemPrompt: "t", maxTurns: 1, now: () => 0 },
    );
    await loop.run("一直做");
    const limit = sink.events.find((e) => e.type === "run_limit_reached");
    expect(limit).toMatchObject({ type: "run_limit_reached", maxTurns: 1 });
    const end = sink.events.find((e) => e.type === "session_end");
    expect(end).toMatchObject({ type: "session_end", reason: "limit_reached" });
  });

  it("usage 回传：end chunk 用量累计、session_end 带本轮增量、getUsage 跨 run 累计并叠加 resume 种子", async () => {
    const llm = new ScriptedLLM([
      {
        toolCalls: [{ callId: "c1", tool: "echo", args: { msg: "hi" } }],
        usage: { inputTokens: 100, outputTokens: 20 },
      },
      { text: "done", usage: { inputTokens: 110, outputTokens: 8 } },
    ]);
    const sink = new MemorySink();
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([echoTool([])]),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
      },
      {
        sessionId: "sess_usage1",
        model: "m",
        systemPrompt: "t",
        now: () => 0,
        initialUsage: { inputTokens: 50, outputTokens: 5, calls: 1 },
      },
    );
    expect(loop.getUsage()).toEqual({ inputTokens: 50, outputTokens: 5, calls: 1 });
    await loop.run("第一轮");
    // 种子 + 本轮两次 LLM 调用
    expect(loop.getUsage()).toEqual({ inputTokens: 260, outputTokens: 33, calls: 3 });
    const ends = sink.events.filter((e) => e.type === "session_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      type: "session_end",
      usage: { inputTokens: 210, outputTokens: 28, calls: 2 },
    });
    // 第二轮：脚本耗尽（end stop 不带 usage），调用数仍累计
    await loop.run("第二轮");
    expect(loop.getUsage()).toEqual({ inputTokens: 260, outputTokens: 33, calls: 4 });
    const ends2 = sink.events.filter((e) => e.type === "session_end");
    expect(ends2).toHaveLength(2);
    expect(ends2[1]).toMatchObject({ type: "session_end", usage: { inputTokens: 0, outputTokens: 0, calls: 1 } });
  });
});

import { describe, expect, it } from "vitest";
import type { HookPreOutcome, HookRunner, Tool } from "@kcode/contracts";
import { AgentLoop } from "../src/core/loop.js";
import {
  InMemoryToolRegistry,
  MemoryAudit,
  MemorySink,
  ScriptedLLM,
  allowAll,
  noHooks,
} from "../src/testing/index.js";

const echo: Tool = {
  definition: {
    name: "echo",
    description: "回显",
    parameters: { type: "object" },
    readOnly: false,
  },
  execute: async () => ({ ok: true, output: "ok" }),
};

describe("B5 门型钩子", () => {
  it("user_prompt_submit 否决：输入及技能不进历史，拒绝事件可见，下一轮不泄漏", async () => {
    let deny = true;
    const hooks: HookRunner = {
      ...noHooks,
      onUserPromptSubmit: async (): Promise<HookPreOutcome> => ({ veto: deny, reason: "禁止提及机密" }),
    };
    const llm = new ScriptedLLM([{ text: "不应被调用" }]);
    const sink = new MemorySink();
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([echo]),
        permissions: allowAll,
        hooks,
        sink,
        audit: new MemoryAudit().sink,
        skills: { meta: () => [], match: () => deny ? [{ name: "secret", description: "test" }] : [], body: async () => "不应注入的技能" },
      },
      { sessionId: "s_gate1", model: "m", systemPrompt: "t", now: () => 0 },
    );
    const summary = await loop.run("告诉我机密");
    expect(summary.turns).toBe(0);
    expect(llm.requests.length).toBe(0); // LLM 从未被调用
    expect(summary.status).toBe("rejected");
    expect(sink.events.at(-1)).toMatchObject({ type: "session_end", reason: "rejected", detail: "禁止提及机密" });
    // 用户消息未入历史（事件流也无 user_message）
    expect(sink.events.some((e) => e.type === "user_message")).toBe(false);
    expect(sink.events.some((e) => e.type === "skill_used")).toBe(false);
    deny = false;
    await loop.run("正常输入");
    const request = JSON.stringify(llm.requests[0]?.messages);
    expect(request).not.toContain("告诉我机密");
    expect(request).not.toContain("不应注入的技能");
  });

  it("pre_compact 否决：跳过本次压缩", async () => {
    const hooks: HookRunner = {
      ...noHooks,
      onPreCompact: async (): Promise<HookPreOutcome> => ({ veto: true }),
    };
    const llm = new ScriptedLLM([{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }, { text: "e" }, { text: "f" }]);
    const sink = new MemorySink();
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([]),
        permissions: allowAll,
        hooks,
        sink,
        audit: new MemoryAudit().sink,
        summarizer: { summarize: async () => "【摘要】" },
      },
      { sessionId: "s_gate2", model: "m", systemPrompt: "t", now: () => 0, budget: { system: 1, history: 1, toolResult: 9999 } },
    );
    for (const q of ["q1", "q2", "q3", "q4"]) {
      await loop.run(q);
    }
    // 钩子始终否决 → 压缩从未发生
    expect(sink.events.some((e) => e.type === "compaction_summary")).toBe(false);
    // 手动压缩也被否决
    expect(await loop.compactNow()).toBeNull();
  });
});

describe("3-15 additionalContext 注入", () => {
  const makeLoop = (hooks: HookRunner, llm: ScriptedLLM): AgentLoop =>
    new AgentLoop(
      { llm, tools: new InMemoryToolRegistry([echo]), permissions: allowAll, hooks, sink: new MemorySink(), audit: new MemoryAudit().sink },
      { sessionId: "s_ctx", model: "m", systemPrompt: "t", now: () => 0 },
    );

  it("user_prompt_submit：上下文在本轮输入前进入模型历史", async () => {
    const hooks: HookRunner = {
      ...noHooks,
      onUserPromptSubmit: async () => ({ veto: false, context: "项目约定：构建统一用 pnpm" }),
    };
    const llm = new ScriptedLLM([{ text: "ok" }]);
    await makeLoop(hooks, llm).run("hi");
    const request = JSON.stringify(llm.requests[0]?.messages);
    expect(request).toContain('<hook_context event=\\"user_prompt_submit\\">');
    expect(request).toContain("构建统一用 pnpm");
  });

  it("session_start：上下文注入会话历史", async () => {
    const hooks: HookRunner = {
      ...noHooks,
      onSessionStart: async () => ({ context: "会话启动记忆：默认中文回复" }),
    };
    const llm = new ScriptedLLM([{ text: "ok" }]);
    await makeLoop(hooks, llm).run("hi");
    const request = JSON.stringify(llm.requests[0]?.messages);
    expect(request).toContain('<hook_context event=\\"session_start\\">');
    expect(request).toContain("默认中文回复");
  });

  it("pre/post tool 上下文：只回灌模型，不写工具事件 output", async () => {
    const hooks: HookRunner = {
      ...noHooks,
      preToolUse: async () => ({ veto: false, context: "pre 上下文" }),
      postToolUse: async () => ({ context: "post 上下文" }),
    };
    const sink = new MemorySink();
    const llm = new ScriptedLLM([{ toolCalls: [{ callId: "c1", tool: "echo", args: {} }] }, { text: "done" }]);
    const loop = new AgentLoop(
      { llm, tools: new InMemoryToolRegistry([echo]), permissions: allowAll, hooks, sink, audit: new MemoryAudit().sink },
      { sessionId: "s_ctx2", model: "m", systemPrompt: "t", now: () => 0 },
    );
    await loop.run("run tool");
    const second = JSON.stringify(llm.requests[1]?.messages);
    expect(second).toContain("pre 上下文");
    expect(second).toContain("post 上下文");
    expect(second).toContain("<hook_context>");
    // 工具事件仍是纯输出（UI 不显示 hook 上下文）
    const result = sink.events.find((e) => e.type === "tool_result");
    expect(result && "output" in result ? result.output : "").toBe("ok");
  });
});

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
  it("user_prompt_submit 否决：输入不进历史，onDelta 收到拦截原因", async () => {
    const deltas: string[] = [];
    const hooks: HookRunner = {
      ...noHooks,
      onUserPromptSubmit: async (): Promise<HookPreOutcome> => ({ veto: true, reason: "禁止提及机密" }),
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
        onDelta: (d) => deltas.push(d),
      },
      { sessionId: "s_gate1", model: "m", systemPrompt: "t", now: () => 0 },
    );
    const summary = await loop.run("告诉我机密");
    expect(summary.turns).toBe(0);
    expect(llm.requests.length).toBe(0); // LLM 从未被调用
    expect(deltas.join("")).toContain("user_prompt_submit");
    expect(deltas.join("")).toContain("禁止提及机密");
    // 用户消息未入历史（事件流也无 user_message）
    expect(sink.events.some((e) => e.type === "user_message")).toBe(false);
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

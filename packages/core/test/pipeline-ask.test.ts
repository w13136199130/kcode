import { describe, expect, it } from "vitest";
import type { PermissionDecision, PermissionEngine, Tool, ToolDefinition } from "@kcode/contracts";
import { AgentLoop } from "../src/core/loop.js";
import { ToolPipeline } from "../src/core/pipeline.js";
import {
  InMemoryToolRegistry,
  MemoryAudit,
  MemorySink,
  ScriptedLLM,
  noHooks,
} from "../src/testing/index.js";

const writeDefinition: ToolDefinition = {
  name: "stamp",
  description: "盖戳",
  parameters: { type: "object" },
  readOnly: false,
};

function stampTool(received: string[]): Tool {
  return {
    definition: writeDefinition,
    execute: async () => {
      received.push("ran");
      return { ok: true, output: "stamped" };
    },
  };
}

function askEngine(): PermissionEngine {
  return { decide: async (): Promise<PermissionDecision> => "ask" };
}

describe("权限 ask 交互流（P1-4）", () => {
  it.each(["approval", "hook"])("在 %s 等待期间取消，即使批准也不得执行工具", async (stage) => {
    const controller = new AbortController();
    const received: string[] = [];
    const audit = new MemoryAudit();
    const pipeline = new ToolPipeline(askEngine(), {
      ...noHooks,
      preToolUse: async () => {
        if (stage === "hook") controller.abort();
        return { veto: false };
      },
    }, audit.sink, "sess_cancel", undefined, {
      confirm: async () => {
        if (stage === "approval") controller.abort();
        return true;
      },
    });
    expect(await pipeline.run(stampTool(received), {}, "c1", controller.signal))
      .toMatchObject({ ok: false, error: "aborted before execution" });
    expect(received).toEqual([]);
    expect(audit.records.some((r) => r.decision === "executed")).toBe(false);
  });

  it("ask + 用户放行 → 工具执行", async () => {
    const received: string[] = [];
    const sink = new MemorySink();
    const audit = new MemoryAudit();
    const loop = new AgentLoop(
      {
        llm: new ScriptedLLM([
          { toolCalls: [{ callId: "c1", tool: "stamp", args: {} }] },
          { text: "done" },
        ]),
        tools: new InMemoryToolRegistry([stampTool(received)]),
        permissions: askEngine(),
        hooks: noHooks,
        sink,
        audit: audit.sink,
        asker: { confirm: async () => true },
      },
      { sessionId: "sess_ask1", model: "m", systemPrompt: "t", now: () => 0 },
    );
    await loop.run("go");
    expect(received).toEqual(["ran"]);
    expect(audit.records.some((r) => r.decision === "executed")).toBe(true);
  });

  it("ask + 用户拒绝 → 不执行、留审计", async () => {
    const received: string[] = [];
    const sink = new MemorySink();
    const audit = new MemoryAudit();
    const loop = new AgentLoop(
      {
        llm: new ScriptedLLM([
          { toolCalls: [{ callId: "c1", tool: "stamp", args: {} }] },
          { text: "stopped" },
        ]),
        tools: new InMemoryToolRegistry([stampTool(received)]),
        permissions: askEngine(),
        hooks: noHooks,
        sink,
        audit: audit.sink,
        asker: { confirm: async () => false },
      },
      { sessionId: "sess_ask2", model: "m", systemPrompt: "t", now: () => 0 },
    );
    await loop.run("go");
    expect(received).toEqual([]);
    expect(audit.records.some((r) => r.decision === "ask-denied" && r.detail === "user denied")).toBe(true);
  });

  it("ask + 无 asker（headless/automation）→ 降级 deny", async () => {
    const received: string[] = [];
    const sink = new MemorySink();
    const loop = new AgentLoop(
      {
        llm: new ScriptedLLM([
          { toolCalls: [{ callId: "c1", tool: "stamp", args: {} }] },
          { text: "stopped" },
        ]),
        tools: new InMemoryToolRegistry([stampTool(received)]),
        permissions: askEngine(),
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
      },
      { sessionId: "sess_ask3", model: "m", systemPrompt: "t", now: () => 0 },
    );
    await loop.run("go");
    expect(received).toEqual([]);
    const denied = sink.events.find((e) => e.type === "tool_result");
    expect(denied && "error" in denied && denied.error).toContain("permission denied");
  });
});

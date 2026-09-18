import { describe, expect, it } from "vitest";
import type { PermissionDecision, PermissionEngine, Tool, ToolDefinition } from "@kcode/contracts";
import { AgentLoop } from "../src/core/loop.js";
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
    expect(audit.records.some((r) => r.decision === "ask" && r.detail === "user denied")).toBe(true);
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

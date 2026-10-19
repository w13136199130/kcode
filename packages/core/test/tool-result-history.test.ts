import { describe, expect, it } from "vitest";
import type { Tool } from "@kcode/contracts";
import { AgentLoop } from "../src/core/loop.js";
import {
  InMemoryToolRegistry,
  MemoryAudit,
  MemorySink,
  ScriptedLLM,
  allowAll,
  noHooks,
} from "../src/testing/index.js";

/**
 * 1-05 集成回归：失败工具的错误行必须进入模型历史。
 * 旧实现 `output !== "" ? output : error` 在 stdout 非空时丢掉 exit code，
 * 模型会把失败的测试/构建当成成功继续下一步。
 */
describe("工具失败原因回灌（集成）", () => {
  it("stdout 非空时仍保留 [失败] exit code", async () => {
    const llm = new ScriptedLLM([
      { toolCalls: [{ callId: "c1", tool: "fail", args: {} }] },
      { text: "done" },
    ]);
    const failTool: Tool = {
      definition: {
        name: "fail",
        description: "总是失败",
        parameters: { type: "object" },
        readOnly: false,
      },
      execute: async () => ({ ok: false, output: "stdout line", error: "exit code 1" }),
    };
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([failTool]),
        permissions: allowAll,
        hooks: noHooks,
        sink: new MemorySink(),
        audit: new MemoryAudit().sink,
      },
      { sessionId: "sess_fail", model: "m", systemPrompt: "t", now: () => 0 },
    );

    await loop.run("run failing tool");
    const toolMsg = llm.requests[1]!.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("[失败] exit code 1");
    expect(toolMsg?.content).toContain("stdout line");
  });
});

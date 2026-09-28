import { describe, expect, it } from "vitest";
import type { Tool, ToolDefinition } from "@kcode/contracts";
import { AgentLoop } from "../src/core/loop.js";
import {
  InMemoryToolRegistry,
  MemoryAudit,
  MemorySink,
  ScriptedLLM,
  allowAll,
  noHooks,
} from "../src/testing/index.js";

/** N2-3 ToolEntry：timeoutMs 结算护栏与 resultBudget 按工具截断 */

const hangDefinition: ToolDefinition = {
  name: "hang",
  description: "永不返回的工具（测试超时护栏）",
  parameters: { type: "object" },
  readOnly: true,
  timeoutMs: 50,
};

const bigOutputDefinition: ToolDefinition = {
  name: "bigout",
  description: "输出远超个人预算的工具",
  parameters: { type: "object" },
  readOnly: true,
  resultBudget: 5,
};

describe("ToolEntry timeoutMs（管线结算护栏）", () => {
  it("超时按失败结算并继续会话；未超时工具不受影响", async () => {
    const llm = new ScriptedLLM([
      { toolCalls: [{ callId: "c1", tool: "hang", args: {} }] },
      { text: "done" },
    ]);
    const hangTool: Tool = {
      definition: hangDefinition,
      execute: () => new Promise(() => {}), // 永不 resolve
    };
    const sink = new MemorySink();
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([hangTool]),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
      },
      { sessionId: "sess_timeout", model: "mock-1", systemPrompt: "test" },
    );

    const summary = await loop.run("call hang");
    expect(summary.status).toBe("completed");
    const result = sink.events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ ok: false });
    expect((result as { error?: string }).error).toContain("timeout after 50ms");
    // 第二轮请求仍发生（失败结果回灌，模型继续）——护栏不挂死会话
    expect(llm.requests.length).toBe(2);
  }, 10_000);
});

describe("ToolEntry resultBudget（结果按工具收紧）", () => {
  it("发给模型的副本按工具预算截断；JSONL 事件保留全文", async () => {
    const big = "长文本。".repeat(400); // ~1200 token，远超 resultBudget 5
    const llm = new ScriptedLLM([
      { toolCalls: [{ callId: "c1", tool: "bigout", args: {} }] },
      { text: "done" },
    ]);
    const bigTool: Tool = {
      definition: bigOutputDefinition,
      execute: async () => ({ ok: true, output: big }),
    };
    const sink = new MemorySink();
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([bigTool]),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
      },
      { sessionId: "sess_budget", model: "mock-1", systemPrompt: "test" },
    );

    await loop.run("call bigout");
    // JSONL 事件全文
    const result = sink.events.find((e) => e.type === "tool_result") as { output: string };
    expect(result.output).toBe(big);
    // 模型侧第二请求中的 tool 消息被截断
    const toolMsg = llm.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("已截断");
    expect(toolMsg?.content.length).toBeLessThan(big.length);
  });
});

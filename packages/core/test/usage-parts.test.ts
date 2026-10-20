import { describe, expect, it } from "vitest";
import type { Tool, ToolDefinition } from "@kcode/contracts";
import { AgentLoop } from "../src/core/loop.js";
import { InMemoryToolRegistry, MemoryAudit, MemorySink, ScriptedLLM, allowAll, noHooks } from "../src/testing/index.js";

const echoDefinition: ToolDefinition = {
  name: "echo",
  description: "回显消息",
  parameters: { type: "object", properties: { msg: { type: "string" } } },
  readOnly: true,
};

function echoTool(): Tool {
  return { definition: echoDefinition, execute: async (input) => ({ ok: true, output: (input as { msg: string }).msg }) };
}

/** 3-21：/cost 分项数据（缓存/推理/byModel/byTool）从流到 SessionUsage 的累计 */
describe("SessionUsage 分项", () => {
  it("缓存命中/写入、推理 token、按工具计数", async () => {
    const llm = new ScriptedLLM([
      {
        toolCalls: [{ callId: "c1", tool: "echo", args: { msg: "hi" } }],
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 10, reasoningTokens: 5 },
      },
      { text: "done", usage: { inputTokens: 30, outputTokens: 4, cacheReadTokens: 20 } },
    ]);
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([echoTool()]),
        permissions: allowAll,
        hooks: noHooks,
        sink: new MemorySink(),
        audit: new MemoryAudit().sink,
      },
      { sessionId: "sess_usage_parts", model: "m", systemPrompt: "t", now: () => 0 },
    );
    await loop.run("跑");
    const usage = loop.getUsage();
    expect(usage).toMatchObject({
      inputTokens: 130,
      outputTokens: 24,
      calls: 2,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      reasoningTokens: 5,
    });
    expect(usage.byTool).toEqual({ echo: 1 });
    expect(usage.byModel?.["m"]).toMatchObject({ inputTokens: 130, cacheReadTokens: 80, reasoningTokens: 5 });
    // 未回报分项的调用不会把已有分项归零
    expect(loop.getUsage().cacheReadTokens).toBe(80);
  });
});

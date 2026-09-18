import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Tool } from "@kcode/contracts";
import { compareIgnoringTs, parseJsonlSession } from "@kcode/runtime";
import { runScriptedSession } from "../src/replay.js";

const echo: Tool = {
  definition: {
    name: "echo",
    description: "回显消息",
    parameters: { type: "object", properties: { msg: { type: "string" } } },
    readOnly: true,
  },
  execute: async (input) => {
    const { msg } = input as { msg: string };
    return { ok: true, output: msg };
  },
};

describe("P0 验收：回放一段录制会话（§11.A ②）", () => {
  it("夹具驱动 core 重放，事件序列一致", async () => {
    const fixtureUrl = new URL("../fixtures/session-001.jsonl", import.meta.url);
    const recorded = parseJsonlSession(readFileSync(fileURLToPath(fixtureUrl), "utf8"));

    const produced = await runScriptedSession({
      sessionId: "sess_fix001",
      userInput: "echo hi and yo",
      script: [
        {
          toolCalls: [
            { callId: "c1", tool: "echo", args: { msg: "hi" } },
            { callId: "c2", tool: "echo", args: { msg: "yo" } },
          ],
        },
        { text: "done" },
      ],
      tools: [echo],
    });

    const result = compareIgnoringTs(recorded, produced);
    if (!result.equal) throw new Error(result.firstDiff);
    expect(result.equal).toBe(true);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentLoop,
  InMemoryToolRegistry,
  MemoryAudit,
  MemorySink,
  ScriptedLLM,
  allowAll,
  noHooks,
} from "@kcode/core";
import { JsonlSessionSink, listSessions, loadSessionEvents, rebuildHistory } from "@kcode/runtime";
import { echoToolFor } from "./helpers.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-e2eres-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("P2-3 E2E：会话 A 落盘 → resume 分支续接", () => {
  it("新会话携带旧会话上下文发起首个请求", async () => {
    const sessionsDir = join(root, "sessions");

    // 会话 A：提问 → 工具 → 结论，事件落盘 JSONL
    const sinkA = new MemorySink();
    const loopA = new AgentLoop(
      {
        llm: new ScriptedLLM([
          { toolCalls: [{ callId: "c1", tool: "echo", args: { msg: "P23" } }] },
          { text: "旧会话结论：P23 已确认。" },
        ]),
        tools: new InMemoryToolRegistry([echoToolFor()]),
        permissions: allowAll,
        hooks: noHooks,
        sink: sinkA,
        audit: new MemoryAudit().sink,
      },
      { sessionId: "sess_a", model: "m", systemPrompt: "t", now: () => 0 },
    );
    await loopA.run("旧会话问题");
    const disk = await JsonlSessionSink.open(join(sessionsDir, "sess_a.jsonl"));
    for (const event of sinkA.events) {
      await disk.append(event);
    }

    // resume：列出 → 重建 → 作为 initialHistory 建分支会话 B
    const summaries = await listSessions(sessionsDir);
    expect(summaries[0]?.sessionId).toBe("sess_a");
    const history = rebuildHistory(await loadSessionEvents(summaries[0]!.filePath));
    expect(history).toHaveLength(4);

    const llmB = new ScriptedLLM([{ text: "续接回答。" }]);
    const loopB = new AgentLoop(
      {
        llm: llmB,
        tools: new InMemoryToolRegistry([echoToolFor()]),
        permissions: allowAll,
        hooks: noHooks,
        sink: new MemorySink(),
        audit: new MemoryAudit().sink,
      },
      { sessionId: "sess_b", model: "m", systemPrompt: "t", initialHistory: history, now: () => 0 },
    );
    await loopB.run("继续上面的话题");

    // 会话 B 的首个请求包含旧会话的用户/助手/工具上下文
    const messages = llmB.requests[0]?.messages ?? [];
    expect(messages.some((m) => m.role === "user" && m.content === "旧会话问题")).toBe(true);
    expect(messages.some((m) => m.role === "assistant" && m.content === "旧会话结论：P23 已确认。")).toBe(
      true,
    );
    expect(messages.some((m) => m.role === "tool" && m.content === "P23")).toBe(true);
  });
});

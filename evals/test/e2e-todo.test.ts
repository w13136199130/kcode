import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@kcode/contracts";
import {
  AgentLoop,
  InMemoryToolRegistry,
  MemoryAudit,
  MemorySink,
  ScriptedLLM,
  allowAll,
  noHooks,
} from "@kcode/core";
import { createSessionTools } from "@kcode/tools";

type TodoEvent = Extract<SessionEvent, { type: "todo_update" }>;

describe("P1-6 E2E：todo 工具经会话工具集发出 todo_update 事件", () => {
  it("scripted todo 调用 → 事件落 sink（JSONL 可回放）", async () => {
    const sink = new MemorySink();
    const loop = new AgentLoop(
      {
        llm: new ScriptedLLM([
          {
            toolCalls: [
              {
                callId: "t1",
                tool: "todo",
                args: {
                  todos: [
                    { content: "调研", status: "completed", priority: "high" },
                    { content: "写码", status: "in_progress" },
                  ],
                },
              },
            ],
          },
          { text: "清单已建。" },
        ]),
        tools: new InMemoryToolRegistry(createSessionTools({ sessionId: "sess_t", sink })),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
      },
      { sessionId: "sess_t", model: "m", systemPrompt: "t", now: () => 0 },
    );
    await loop.run("建任务清单");
    const todoEvent = sink.events.find((e): e is TodoEvent => e.type === "todo_update");
    expect(todoEvent?.todos.map((t) => `${t.status}:${t.content}`)).toEqual([
      "completed:调研",
      "in_progress:写码",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionSink } from "@kcode/contracts";
import { createAskUserTool, createTodoTool } from "../src/index.js";

class MemorySink implements SessionSink {
  readonly events: SessionEvent[] = [];
  append(event: SessionEvent): void {
    this.events.push(event);
  }
}

const todoCall = {
  todos: [
    { content: "调研", status: "completed", priority: "high" },
    { content: "写码", status: "in_progress" },
    { content: "测试", status: "pending", priority: "low" },
  ],
};

describe("todo 工具（§1.1 A 域）", () => {
  it("全量替换并经 sink 发 todo_update 事件", async () => {
    const sink = new MemorySink();
    const todo = createTodoTool({ sessionId: "s1", sink });
    const r = await todo.execute(todoCall, { sessionId: "s1" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("3 项");
    const event = sink.events.find((e) => e.type === "todo_update");
    expect(event && "todos" in event ? event.todos : []).toHaveLength(3);
  });

  it("多个 in_progress 被拒绝", async () => {
    const todo = createTodoTool({ sessionId: "s1", sink: new MemorySink() });
    const r = await todo.execute(
      {
        todos: [
          { content: "a", status: "in_progress" },
          { content: "b", status: "in_progress" },
        ],
      },
      { sessionId: "s1" },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("in_progress");
  });

  it("非法参数被拒绝", async () => {
    const todo = createTodoTool({ sessionId: "s1" });
    const r = await todo.execute({ wrong: true }, { sessionId: "s1" });
    expect(r.ok).toBe(false);
  });
});

describe("ask_user 工具（结构化提问）", () => {
  const question = {
    question: "用哪个方案？",
    options: [
      { label: "方案 A", description: "快" },
      { label: "方案 B", description: "稳" },
    ],
  };

  it("无 prompt（非交互）返回降级话术", async () => {
    const askUser = createAskUserTool({});
    const r = await askUser.execute(question, { sessionId: "s1" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("不可交互");
  });

  it("有 prompt 时返回用户选择", async () => {
    const askUser = createAskUserTool({ prompt: { ask: async () => ["方案 A"] } });
    const r = await askUser.execute(question, { sessionId: "s1" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("方案 A");
  });

  it("用户未选择时提示跳过", async () => {
    const askUser = createAskUserTool({ prompt: { ask: async () => [] } });
    const r = await askUser.execute(question, { sessionId: "s1" });
    expect(r.output).toContain("未作选择");
  });

  it("选项数不足被 schema 拒绝", async () => {
    const askUser = createAskUserTool({ prompt: { ask: async () => [] } });
    const r = await askUser.execute(
      { question: "q", options: [{ label: "only" }] },
      { sessionId: "s1" },
    );
    expect(r.ok).toBe(false);
  });
});

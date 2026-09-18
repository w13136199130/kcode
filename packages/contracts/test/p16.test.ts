import { describe, expect, it } from "vitest";
import { SessionEvent, StructuredQuestion, TodoUpdateEvent } from "../src/index.js";

describe("P1-6 schema", () => {
  it("TodoUpdateEvent 进 SessionEvent 联合且可回放解析", () => {
    const raw = {
      v: 1,
      type: "todo_update",
      ts: 0,
      sessionId: "s1",
      todos: [
        { content: "调研", status: "completed", priority: "high" },
        { content: "写码", status: "in_progress" },
      ],
    };
    const parsed = TodoUpdateEvent.parse(raw);
    expect(parsed.todos).toHaveLength(2);
    expect(parsed.todos[1]?.priority).toBe("medium"); // 缺省回落
    expect(SessionEvent.safeParse(raw).success).toBe(true);
  });

  it("StructuredQuestion 至少 2 个选项", () => {
    expect(
      StructuredQuestion.safeParse({ question: "q", options: [{ label: "a" }] }).success,
    ).toBe(false);
    expect(
      StructuredQuestion.safeParse({
        question: "q",
        options: [
          { label: "a", description: "描述" },
          { label: "b" },
        ],
        multiSelect: true,
      }).success,
    ).toBe(true);
  });
});

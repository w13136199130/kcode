import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@kcode/contracts";
import { planCompaction } from "../src/context/compact.js";
import { DEFAULT_BUDGET } from "../src/context/budget.js";

/**
 * N0/3-13：压缩切点必须落在完整轮次边界（user 开头），
 * 不允许 keepTail 从 assistant/tool 中间开始，也不允许 toSummarize 以半个工具对结束。
 */
const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });
const tool = (content: string): ChatMessage => ({
  role: "tool",
  content,
  toolCallId: "c1",
  name: "echo",
});

describe("planCompaction 轮次边界", () => {
  it("切点落在 tool 中段时向右落到下一个 user（保留完整近期轮次）", () => {
    const history: ChatMessage[] = [
      user("u1"),
      assistant("a1"),
      user("u2"),
      assistant("a2"),
      tool("t2"),
      assistant("a2b"),
      user("u3"),
      assistant("a3"),
      user("u4"),
      assistant("a4"),
      user("u5"),
      assistant("a5"),
      user("u6"),
      assistant("a6"),
    ];
    const plan = planCompaction(history, DEFAULT_BUDGET, true);
    expect(plan).not.toBeNull();
    // 14 - KEEP_TAIL(10) = 4（tool）；向右最近的 user 是 index 6
    expect(plan!.keepTail[0]).toMatchObject({ role: "user", content: "u3" });
    expect(plan!.toSummarize.at(-1)).toMatchObject({ role: "assistant", content: "a2b" });
    expect(plan!.toSummarize.some((m) => m.role === "tool")).toBe(true); // 完整工具对仍在摘要区
  });

  it("末尾没有后续 user 时向左落到最近 user（保住最后一轮完整）", () => {
    const history: ChatMessage[] = [
      user("u1"),
      assistant("a1"),
      user("u2"),
      assistant("a2"),
      user("u3"),
      assistant("a3"),
      user("u4"),
      assistant("a4"),
      user("u5"),
      assistant("a5"),
      user("u6"),
      assistant("a6"),
      tool("t6"),
      assistant("a6b"),
    ];
    const plan = planCompaction(history, DEFAULT_BUDGET, true);
    expect(plan).not.toBeNull();
    // initial=4；后续有 user，split 落 u5（index 8），keepTail 以 user 开头
    expect(plan!.keepTail[0]).toMatchObject({ role: "user" });
    expect(plan!.toSummarize.length).toBeGreaterThan(0);
    expect(plan!.toSummarize.at(-1)?.role).not.toBe("tool");
  });

  it("切点本身就是 user 时保持不动", () => {
    const history: ChatMessage[] = Array.from({ length: 12 }, (_, i) => user(`u${i}`));
    const plan = planCompaction(history, DEFAULT_BUDGET, true);
    expect(plan).not.toBeNull();
    expect(plan!.keepTail[0]).toMatchObject({ role: "user", content: "u2" });
    expect(plan!.toSummarize.at(-1)).toMatchObject({ role: "user", content: "u1" });
  });

  it("没有可折叠完整轮次时不压缩（切点落在首 user）", () => {
    const history: ChatMessage[] = [user("u1"), assistant("a1"), user("u2"), assistant("a2")];
    expect(planCompaction(history, DEFAULT_BUDGET, true)).toBeNull();
  });
});

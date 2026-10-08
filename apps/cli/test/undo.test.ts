import { describe, expect, it } from "vitest";
import { UndoStack } from "../src/tui/input/undo.js";

/** N3G-2：undo/redo 快照双栈——合并窗口、边界、上限、redo 失效 */

describe("UndoStack", () => {
  it("100ms 窗口内合并为一个撤销单元；窗口锚定入栈点（长连打按块分段）", () => {
    const u = new UndoStack();
    let t = 0;
    u.push("", false, t); // 首键：入栈 ""
    u.push("a", false, t + 30); // 窗口内：跳过
    u.push("ab", false, t + 60); // 窗口内：跳过
    expect(u.depth).toBe(1);
    t += 150;
    u.push("abc", false, t); // 过窗：入栈 "abc"
    u.push("abcd", false, t + 40); // 窗口内
    expect(u.depth).toBe(2);
    expect(u.undo("abcde")).toBe("abc");
    expect(u.undo("abc")).toBe("");
    expect(u.undo("")).toBeNull();
  });

  it("boundary 跳过合并窗口：粘贴/提交各自成单元", () => {
    const u = new UndoStack();
    const t = 0;
    u.push("", false, t);
    u.push("ab", true, t + 5); // 粘贴：立即入栈
    expect(u.depth).toBe(2);
    expect(u.undo("ab粘贴")).toBe("ab");
    expect(u.undo("ab")).toBe("");
  });

  it("undo/redo 往返；新编辑使 redo 失效", () => {
    const u = new UndoStack();
    u.push("", true);
    u.push("a", true);
    expect(u.undo("ab")).toBe("a");
    expect(u.redo("a")).toBe("ab");
    expect(u.redo("ab")).toBeNull();
    expect(u.undo("ab")).toBe("a");
    expect(u.undo("a")).toBe("");
    u.push("", true); // 新编辑
    expect(u.redo("x")).toBeNull(); // redo 已清空
  });

  it("上限 50：超限丢最旧", () => {
    const u = new UndoStack(3);
    for (const v of ["", "a", "b", "c", "d"]) {
      u.push(v, true);
    }
    expect(u.depth).toBe(3);
    expect(u.undo("e")).toBe("d");
    expect(u.undo("d")).toBe("c");
    expect(u.undo("c")).toBe("b");
  });
});

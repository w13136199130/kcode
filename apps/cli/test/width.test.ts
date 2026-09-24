import { describe, expect, it } from "vitest";
import { nextBoundary, previousBoundary, visualWidth, wrapVisual, truncateVisual } from "../src/tui/width.js";

describe("终端字符簇与显示宽度", () => {
  it("中文双宽，组合重音单宽，emoji 序列不按码点累加", () => {
    expect(visualWidth("版本2")).toBe(5);
    expect(visualWidth("e\u0301")).toBe(1);
    expect(visualWidth("👨‍👩‍👧‍👦")).toBe(2);
    expect(visualWidth("α")).toBe(1);
  });
  it("移动、删除及截断不拆 emoji 或组合字符", () => {
    const text = "A👨‍👩‍👧‍👦e\u0301中";
    const end = nextBoundary(text, 1);
    expect(text.slice(1, end)).toBe("👨‍👩‍👧‍👦");
    expect(previousBoundary(text, end)).toBe(1);
    expect(truncateVisual(text, 2)).toBe("A");
    expect(truncateVisual(text, 4)).toBe("A👨‍👩‍👧‍👦e\u0301");
  });
  it.each([80, 120])("%i 列换行保留显式换行和内容", (columns) => {
    const text = "中".repeat(columns) + "e\u0301👩🏽‍💻";
    const lines = wrapVisual(text, columns);
    expect(lines.join("")).toBe(text);
    expect(lines.every((line) => visualWidth(line) <= columns)).toBe(true);
    expect(wrapVisual("a\nb\n", columns)).toEqual(["a", "b", ""]);
  });
});

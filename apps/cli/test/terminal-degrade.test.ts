import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { glyph, rawColor } from "../src/tui/theme/theme.js";

/**
 * 3-26 降级：字面量颜色（markdown 语法色/gray）与状态符也要跟随
 * NO_COLOR / KCODE_PLAIN / KCODE_THEME=light，而不只是语义色 c()。
 */

const saved = { ...process.env };
const KEYS = ["NO_COLOR", "KCODE_PLAIN", "KCODE_THEME"] as const;
beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of KEYS) {
    delete process.env[key];
    if (saved[key] !== undefined) process.env[key] = saved[key];
  }
});

describe("终端降级开关", () => {
  it("KCODE_THEME=light：ANSI 名字面量映射到白底可读的深色", () => {
    process.env["KCODE_THEME"] = "light";
    expect(rawColor("cyan")).toBe("#0369a1");
    expect(rawColor("green")).toBe("#15803d");
    expect(rawColor("gray")).toBe("#64748b");
    expect(rawColor("#c4b5fd")).toBe("#c4b5fd"); // 非 ANSI 名字面量不动
  });

  it("NO_COLOR/KCODE_PLAIN：颜色一律 undefined；PLAIN 状态符退 ASCII", () => {
    process.env["NO_COLOR"] = "1";
    expect(rawColor("cyan")).toBeUndefined();
    delete process.env["NO_COLOR"];
    process.env["KCODE_PLAIN"] = "1";
    expect(rawColor("green")).toBeUndefined();
    expect(glyph("✓", "+")).toBe("+");
    expect(glyph("✗", "x")).toBe("x");
  });

  it("默认环境保留原色与原字形", () => {
    expect(rawColor("cyan")).toBe("cyan");
    expect(glyph("✓", "+")).toBe("✓");
  });
});

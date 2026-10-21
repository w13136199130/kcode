import { describe, expect, it } from "vitest";
import {
  TERMINAL_COLORS,
  TERMINAL_COLORS_LIGHT,
  TERMINAL_SYMBOLS,
  contrastRatio,
  meetsWcagAA,
  terminalColor,
  type SemanticColor,
} from "../src/index.js";

/**
 * 3-35：终端主题对比度审计。
 * 假定深色终端背景 #0c0c0c（Windows Terminal 默认黑）与亮色 #ffffff；
 * 所有带色令牌必须为 hex 且达到 WCAG AA 4.5:1（普通文本）。
 */
const DARK_BG = "#0c0c0c";
const LIGHT_BG = "#ffffff";
const STATUS: SemanticColor[] = [
  "brand",
  "accent",
  "success",
  "warning",
  "destructive",
  "info",
  "diffAdded",
  "diffRemoved",
  "diffContext",
  "interactionAsk",
  "interactionConfirm",
  "foregroundSubtle",
];

describe("终端配色对比度（3-35）", () => {
  it("深色主题所有语义色 ≥ 4.5:1，且为确定性 hex", () => {
    for (const token of STATUS) {
      const color = TERMINAL_COLORS[token];
      expect(color, token).toMatch(/^#[0-9a-f]{6}$/i);
      expect(contrastRatio(color!, DARK_BG), token).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("亮色主题所有语义色 ≥ 4.5:1", () => {
    for (const token of STATUS) {
      const color = TERMINAL_COLORS_LIGHT[token];
      expect(color, token).toMatch(/^#[0-9a-f]{6}$/i);
      expect(contrastRatio(color!, LIGHT_BG), token).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("对比度公式边界：黑/白 21:1；AA 判定", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(meetsWcagAA("#000000", "#ffffff")).toBe(true);
    expect(meetsWcagAA("#777777", "#ffffff")).toBe(false);
  });

  it("状态符号回退存在（色盲/无色终端可辨）", () => {
    expect(TERMINAL_SYMBOLS.success).toBe("✓");
    expect(TERMINAL_SYMBOLS.destructive).toBe("✗");
    expect(TERMINAL_SYMBOLS.warning).toBe("!");
  });

  it("KCODE_THEME=dark 与默认一致（显式暗色不需要特殊分支）", () => {
    expect(terminalColor("success", { KCODE_THEME: "dark" })).toBe(TERMINAL_COLORS.success);
  });
});

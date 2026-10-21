import { describe, expect, it } from "vitest";
import { terminalColor, terminalSymbol } from "../src/index.js";

/** 显式 env：不依赖测试宿主的 NO_COLOR/KCODE_THEME */
const DARK: NodeJS.ProcessEnv = {};

describe("设计令牌与终端映射", () => {
  it("语义令牌映射到终端颜色；正文继承前景色", () => {
    // 状态色为柔和 hex（zcode 暗色主题同值——饱和 ANSI 蓝绿在深底"太深"，截图反馈实测）
    expect(terminalColor("brand", DARK)).toBe("#22d3ee");
    expect(terminalColor("accent", DARK)).toBe("#c4b5fd");
    expect(terminalColor("success", DARK)).toBe("#86efac");
    expect(terminalColor("warning", DARK)).toBe("#fbbf24");
    expect(terminalColor("destructive", DARK)).toBe("#fca5a5");
    expect(terminalColor("foregroundSubtle", DARK)).toBe("#94a3b8");
    expect(terminalColor("info", DARK)).toBe("#7dd3fc");
    // 正文不指定颜色（undefined = 继承终端前景色），避免浅色终端白字不可读
    expect(terminalColor("foreground", DARK)).toBeUndefined();
  });

  it("无色回退符号", () => {
    expect(terminalSymbol("success", DARK)).toBe("✓");
    expect(terminalSymbol("destructive", DARK)).toBe("✗");
    expect(terminalSymbol("foreground", DARK)).toBeUndefined();
  });

  it("3-26：NO_COLOR/KCODE_PLAIN 关闭颜色，KCODE_THEME=light 用深色变体", () => {
    expect(terminalColor("success", { NO_COLOR: "1" })).toBeUndefined();
    expect(terminalColor("success", { NO_COLOR: "" })).toBe("#86efac"); // 空值按规范不生效
    expect(terminalColor("brand", { KCODE_PLAIN: "1" })).toBeUndefined();
    expect(terminalColor("success", { KCODE_THEME: "light" })).toBe("#15803d");
    expect(terminalColor("brand", { KCODE_THEME: "light" })).toBe("#1d4ed8");
    // light 与无色开关组合仍以无色优先
    expect(terminalColor("success", { KCODE_THEME: "light", NO_COLOR: "1" })).toBeUndefined();
  });

  it("3-26：KCODE_PLAIN 状态符退化为 ASCII", () => {
    expect(terminalSymbol("success", { KCODE_PLAIN: "1" })).toBe("+");
    expect(terminalSymbol("destructive", { KCODE_PLAIN: "1" })).toBe("x");
  });
});

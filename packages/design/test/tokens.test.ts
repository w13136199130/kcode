import { describe, expect, it } from "vitest";
import { terminalColor, terminalSymbol } from "../src/index.js";

describe("设计令牌与终端映射", () => {
  it("语义令牌映射到终端颜色；正文继承前景色", () => {
    // 状态色为柔和 hex（zcode 暗色主题同值——饱和 ANSI 蓝绿在深底"太深"，截图反馈实测）
    expect(terminalColor("brand")).toBe("cyan");
    expect(terminalColor("accent")).toBe("#c4b5fd");
    expect(terminalColor("success")).toBe("#86efac");
    expect(terminalColor("warning")).toBe("#fbbf24");
    expect(terminalColor("destructive")).toBe("#fca5a5");
    expect(terminalColor("foregroundSubtle")).toBe("#94a3b8");
    expect(terminalColor("info")).toBe("#7dd3fc");
    // 正文不指定颜色（undefined = 继承终端前景色），避免浅色终端白字不可读
    expect(terminalColor("foreground")).toBeUndefined();
  });

  it("无色回退符号", () => {
    expect(terminalSymbol("success")).toBe("✓");
    expect(terminalSymbol("destructive")).toBe("✗");
    expect(terminalSymbol("foreground")).toBeUndefined();
  });
});

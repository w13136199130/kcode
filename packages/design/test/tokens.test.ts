import { describe, expect, it } from "vitest";
import { terminalColor, terminalSymbol } from "../src/index.js";

describe("设计令牌与终端映射", () => {
  it("语义令牌映射到终端颜色；正文继承前景色", () => {
    expect(terminalColor("brand")).toBe("cyan");
    expect(terminalColor("accent")).toBe("magenta");
    expect(terminalColor("success")).toBe("green");
    expect(terminalColor("warning")).toBe("yellow");
    expect(terminalColor("destructive")).toBe("red");
    // 正文不指定颜色（undefined = 继承终端前景色），避免浅色终端白字不可读
    expect(terminalColor("foreground")).toBeUndefined();
  });

  it("无色回退符号", () => {
    expect(terminalSymbol("success")).toBe("✓");
    expect(terminalSymbol("destructive")).toBe("✗");
    expect(terminalSymbol("foreground")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { DESKTOP_CLASSIC_DARK, DESKTOP_CLASSIC_LIGHT, desktopClassicTheme } from "../src/desktop.js";

/** S1-5（F19）令牌收口：--z-* 调色板唯一像素来源校验。 */
describe("desktop classic theme（S1-5）", () => {
  it("亮/暗映射键集合一致且覆盖全部 --z-* 消费变量", () => {
    expect(Object.keys(DESKTOP_CLASSIC_DARK).sort()).toEqual(Object.keys(DESKTOP_CLASSIC_LIGHT).sort());
    for (const key of Object.keys(DESKTOP_CLASSIC_LIGHT)) {
      expect(key.startsWith("--z-")).toBe(true);
    }
    expect(Object.keys(DESKTOP_CLASSIC_LIGHT)).toHaveLength(13);
  });

  it("CSS 输出含亮色 :root 与暗色 prefers-color-scheme 块", () => {
    const css = desktopClassicTheme();
    expect(css).toContain(":root");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain("--z-fg: #1a1a2e");
    expect(css).toContain("--z-fg: #d4d4d4");
  });
});

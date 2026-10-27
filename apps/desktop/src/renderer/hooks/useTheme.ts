import { useEffect, useState } from "react";
import { DESKTOP_CLASSIC_DARK, DESKTOP_CLASSIC_LIGHT } from "@kcode/design";

export type ThemeMode = "system" | "light" | "dark";

/**
 * 主题覆盖：沿用桌面 `--z-*` 变量表，设置页与主界面共享。
 * S1-5：像素值唯一来源在 @kcode/design（与 desktopClassicTheme 同一份映射）。
 */
export function useTheme(): { theme: ThemeMode; setTheme(value: ThemeMode): void } {
  const [theme, setTheme] = useState<ThemeMode>(
    () => (localStorage.getItem("kcode-theme") as ThemeMode | null) ?? "system",
  );

  useEffect(() => {
    const styleId = "kcode-theme-override";
    document.getElementById(styleId)?.remove();
    if (theme !== "system") {
      const dark = theme === "dark";
      const vars = [
        "--z-bg",
        "--z-panel",
        "--z-card",
        "--z-border",
        "--z-border-hover",
        "--z-surface",
        "--z-surface-hover",
        "--z-selected",
        "--z-fg",
        "--z-fg-subtle",
        "--z-fg-subtlest",
        "--z-scroll-thumb",
        "--z-code-bg",
      ];
      const light = DESKTOP_CLASSIC_LIGHT;
      const darkMap = DESKTOP_CLASSIC_DARK;
      const map = dark ? darkMap : light;
      const el = document.createElement("style");
      el.id = styleId;
      el.textContent = `:root { ${vars.map((v) => `${v}: ${map[v]!};`).join(" ")} }`;
      document.head.appendChild(el);
    }
    localStorage.setItem("kcode-theme", theme);
  }, [theme]);

  return { theme, setTheme };
}

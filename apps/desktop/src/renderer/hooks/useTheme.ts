import { useEffect, useState } from "react";

export type ThemeMode = "system" | "light" | "dark";

/**
 * 主题覆盖：沿用桌面既有的 `--z-*` 变量表，设置页与主界面共享。
 * v2 侧栏当前使用纯白设计变量；主界面跟随这里切换。
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
      const light: Record<string, string> = {
        "--z-bg": "#fafafa",
        "--z-panel": "#ffffff",
        "--z-card": "#f3f4f6",
        "--z-border": "rgba(0,0,0,0.1)",
        "--z-border-hover": "rgba(0,0,0,0.15)",
        "--z-surface": "rgba(0,0,0,0.04)",
        "--z-surface-hover": "rgba(0,0,0,0.07)",
        "--z-selected": "rgba(0,0,0,0.08)",
        "--z-fg": "#1a1a2e",
        "--z-fg-subtle": "rgba(26,26,46,0.6)",
        "--z-fg-subtlest": "rgba(26,26,46,0.35)",
        "--z-scroll-thumb": "rgba(0,0,0,0.18)",
        "--z-code-bg": "#f6f8fa",
      };
      const darkMap: Record<string, string> = {
        "--z-bg": "#161616",
        "--z-panel": "#202020",
        "--z-card": "#2b2b2b",
        "--z-border": "rgba(255,255,255,0.1)",
        "--z-border-hover": "rgba(255,255,255,0.15)",
        "--z-surface": "rgba(255,255,255,0.05)",
        "--z-surface-hover": "rgba(255,255,255,0.1)",
        "--z-selected": "rgba(255,255,255,0.1)",
        "--z-fg": "#d4d4d4",
        "--z-fg-subtle": "rgba(212,212,212,0.6)",
        "--z-fg-subtlest": "rgba(212,212,212,0.3)",
        "--z-scroll-thumb": "rgba(255,255,255,0.14)",
        "--z-code-bg": "#161b26",
      };
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

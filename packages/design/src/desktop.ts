/**
 * 桌面端专用令牌（D3-UI）。
 *
 * 与 Web 的 `WEB_LIGHT` / `WEB_DARK` 分开：桌面 v2 是纯白中性色，
 * 不能改写 Web/CLI 已经在消费的语义色。这里只提供桌面 CSS 变量。
 */
export const DESKTOP_LIGHT = {
  surface: "#ffffff",
  surfaceSubtle: "#fafafa",
  surfaceHover: "#f5f5f5",
  surfaceSelected: "#f2f2f2",
  border: "#ececec",
  borderStrong: "#d9d9d9",
  ink: "#111111",
  inkSoft: "#333333",
  muted: "#666666",
  faint: "#999999",
  accent: "#2563eb",
  danger: "#c24141",
  success: "#17803d",
} as const;

export const DESKTOP_TYPE = {
  ui: 14,
  title: 14,
  secondary: 12.5,
  meta: 11,
  body: 14.5,
} as const;

export const DESKTOP_SPACING = [2, 4, 6, 8, 10, 12, 16, 20, 24, 32] as const;

export const DESKTOP_RADII = [4, 6, 8, 10, 12, 16] as const;

/** 生成桌面 CSS 变量（--kc-*），不覆盖 Web 的 --kcode-*。 */
export function desktopCssTheme(): string {
  const entries = Object.entries(DESKTOP_LIGHT)
    .map(([key, value]) => `--kc-${kebab(key)}: ${value};`)
    .join("\n  ");
  return `:root {\n  ${entries}\n}`;
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * S1-5（F19）令牌收口：桌面经典 `--z-*` 调色板的唯一像素来源迁入本包。
 * 此前同样的值分散在 renderer styles.css 与 useTheme.ts 三处；现在 renderer 只消费：
 * - `desktopClassicTheme()`：注入 light `:root` + dark `@media`（跟随系统）；
 * - `DESKTOP_CLASSIC_LIGHT/DARK`：useTheme 显式覆盖时取同一份映射。
 */
export const DESKTOP_CLASSIC_LIGHT: Record<string, string> = {
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

export const DESKTOP_CLASSIC_DARK: Record<string, string> = {
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

function classicBlock(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([key, value]) => `${key}: ${value};`)
    .join("\n  ");
}

/** 经典 `--z-*` 主题（亮色默认 + prefers-color-scheme 暗色）；显式覆盖由 useTheme 注入更晚的样式。 */
export function desktopClassicTheme(): string {
  return `:root {\n  ${classicBlock(DESKTOP_CLASSIC_LIGHT)}\n}\n@media (prefers-color-scheme: dark) {\n  :root {\n    ${classicBlock(DESKTOP_CLASSIC_DARK).replaceAll("\n  ", "\n    ")}\n  }\n}`;
}

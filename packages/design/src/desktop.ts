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

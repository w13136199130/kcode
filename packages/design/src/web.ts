import type { SemanticColor } from "./tokens.js";

/**
 * 语义令牌 → Web CSS 变量名。
 * Web/桌面（Chromium DOM）消费时以 CSS 变量引用（`var(--kcode-brand)`），
 * 具体色值由主题（亮/暗）在 `:root` 级定义——「共享语义，不共享像素」。
 */
export const WEB_CSS_VARS: Record<SemanticColor, string> = {
  foreground: "--kcode-foreground",
  foregroundSubtle: "--kcode-foreground-subtle",
  brand: "--kcode-brand",
  accent: "--kcode-accent",
  success: "--kcode-success",
  warning: "--kcode-warning",
  destructive: "--kcode-destructive",
  info: "--kcode-info",
  diffAdded: "--kcode-diff-added",
  diffRemoved: "--kcode-diff-removed",
  diffContext: "--kcode-diff-context",
  interactionAsk: "--kcode-interaction-ask",
  interactionConfirm: "--kcode-interaction-confirm",
};

/** 语义令牌 → 亮色主题具体色值（跟随系统偏好自动切换暗色） */
export const WEB_LIGHT: Record<SemanticColor, string> = {
  foreground: "#1a1a2e",
  foregroundSubtle: "#6b7280",
  brand: "#0891b2",
  accent: "#7c3aed",
  success: "#16a34a",
  warning: "#d97706",
  destructive: "#dc2626",
  info: "#2563eb",
  diffAdded: "#16a34a",
  diffRemoved: "#dc2626",
  diffContext: "#9ca3af",
  interactionAsk: "#d97706",
  interactionConfirm: "#16a34a",
};

/** 语义令牌 → 暗色主题具体色值 */
export const WEB_DARK: Record<SemanticColor, string> = {
  foreground: "#e5e7eb",
  foregroundSubtle: "#9ca3af",
  brand: "#22d3ee",
  accent: "#a78bfa",
  success: "#4ade80",
  warning: "#fbbf24",
  destructive: "#f87171",
  info: "#60a5fa",
  diffAdded: "#4ade80",
  diffRemoved: "#f87171",
  diffContext: "#6b7280",
  interactionAsk: "#fbbf24",
  interactionConfirm: "#4ade80",
};

/** 生成注入 `:root` 的 CSS 变量声明块（亮色 + 暗色自动切换） */
export function webCssTheme(): string {
  const light = Object.entries(WEB_CSS_VARS)
    .map(([key, cssVar]) => `${cssVar}: ${WEB_LIGHT[key as SemanticColor]};`)
    .join("\n  ");
  const dark = Object.entries(WEB_CSS_VARS)
    .map(([key, cssVar]) => `${cssVar}: ${WEB_DARK[key as SemanticColor]};`)
    .join("\n  ");
  return `:root {\n  ${light}\n}\n@media (prefers-color-scheme: dark) {\n  :root {\n  ${dark}\n  }\n}`;
}

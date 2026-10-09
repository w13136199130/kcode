import type { SemanticColor } from "./tokens.js";

/**
 * 语义令牌 → 终端颜色（Ink 支持 hex；比 ANSI 亮色名柔和一档，对标 zcode 暗色主题
 * #94a3b8/#86efac/#fbbf24/#fca5a5/#7dd3fc——饱和 ANSI 蓝绿在深底上"太深"是截图反馈实测）。
 * undefined = 继承终端前景色
 */
export const TERMINAL_COLORS: Record<SemanticColor, string | undefined> = {
  foreground: undefined,
  foregroundSubtle: "#94a3b8",
  brand: "cyan",
  // ANSI magenta 在 Windows Terminal 渲染成 ~#800080 深紫（截图反馈"太深"）；
  // CC 选中菜单描述/面板标题是淡薰衣草紫——hex 恒定
  accent: "#c4b5fd",
  success: "#86efac",
  warning: "#fbbf24",
  destructive: "#fca5a5",
  info: "#7dd3fc",
  diffAdded: "green",
  diffRemoved: "red",
  diffContext: "gray",
  interactionAsk: "yellow",
  interactionConfirm: "green",
};

/** 语义令牌 → 无色回退符号（无色终端/色盲用户可辨状态） */
export const TERMINAL_SYMBOLS: Partial<Record<SemanticColor, string>> = {
  success: "✓",
  destructive: "✗",
  warning: "!",
  diffAdded: "+",
  diffRemoved: "-",
  interactionAsk: "?",
  interactionConfirm: "✓",
};

/** 取语义令牌的终端颜色 */
export function terminalColor(token: SemanticColor): string | undefined {
  return TERMINAL_COLORS[token];
}

/** 取语义令牌的无色符号回退 */
export function terminalSymbol(token: SemanticColor): string | undefined {
  return TERMINAL_SYMBOLS[token];
}

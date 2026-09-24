import type { SemanticColor } from "./tokens.js";

/** 语义令牌 → 终端颜色（Ink/ANSI 色名）。undefined = 继承终端前景色 */
export const TERMINAL_COLORS: Record<SemanticColor, string | undefined> = {
  foreground: undefined,
  foregroundSubtle: "gray",
  brand: "cyan",
  accent: "magenta",
  success: "green",
  warning: "yellow",
  destructive: "red",
  info: "blue",
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

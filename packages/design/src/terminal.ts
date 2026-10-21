import type { SemanticColor } from "./tokens.js";

/**
 * 语义令牌 → 终端颜色（Ink 支持 hex；比 ANSI 亮色名柔和一档，对标 zcode 暗色主题
 * #94a3b8/#86efac/#fbbf24/#fca5a5/#7dd3fc——饱和 ANSI 蓝绿在深底上"太深"是截图反馈实测）。
 * undefined = 继承终端前景色
 */
export const TERMINAL_COLORS: Record<SemanticColor, string | undefined> = {
  foreground: undefined,
  foregroundSubtle: "#94a3b8",
  brand: "#22d3ee",
  // ANSI magenta 在 Windows Terminal 渲染成 ~#800080 深紫（截图反馈"太深"）；
  // CC 选中菜单描述/面板标题是淡薰衣草紫——hex 恒定
  accent: "#c4b5fd",
  success: "#86efac",
  warning: "#fbbf24",
  destructive: "#fca5a5",
  info: "#7dd3fc",
  // 3-35：diff/交互状态也固定 hex（ANSI red/green 随终端主题浮动，红在深底可能低于 4.5:1）
  diffAdded: "#86efac",
  diffRemoved: "#fca5a5",
  diffContext: "#94a3b8",
  interactionAsk: "#fbbf24",
  interactionConfirm: "#86efac",
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

/** 亮色主题：白底可读的深色变体（3-26 `KCODE_THEME=light`） */
export const TERMINAL_COLORS_LIGHT: Record<SemanticColor, string | undefined> = {
  foreground: undefined,
  foregroundSubtle: "#64748b",
  brand: "#0e7490",
  accent: "#7c3aed",
  success: "#15803d",
  warning: "#b45309",
  destructive: "#dc2626",
  info: "#0369a1",
  diffAdded: "#15803d",
  diffRemoved: "#dc2626",
  diffContext: "#64748b",
  interactionAsk: "#b45309",
  interactionConfirm: "#15803d",
};

/** 设计层不依赖 Node 类型（web 端也会 import 本文件）：只约定键值形状 */
export type TerminalEnv = Record<string, string | undefined>;

function readEnv(env?: TerminalEnv): TerminalEnv {
  if (env !== undefined) {
    return env;
  }
  const proc = (globalThis as { process?: { env?: TerminalEnv } }).process;
  return proc?.env ?? {};
}

/** 3-26：NO_COLOR（非空）/ KCODE_PLAIN=1 一律无色 */
export function colorsDisabled(env?: TerminalEnv): boolean {
  const e = readEnv(env);
  return (e["NO_COLOR"] !== undefined && e["NO_COLOR"] !== "") || e["KCODE_PLAIN"] === "1";
}

/** 3-26：KCODE_PLAIN=1 用 ASCII 状态符（CI/日志/不支持等宽字形的终端） */
export function plainGlyphs(env?: TerminalEnv): boolean {
  return readEnv(env)["KCODE_PLAIN"] === "1";
}

/** KCODE_PLAIN=1 的 ASCII 状态符（3-26） */
const ASCII_SYMBOLS: Partial<Record<SemanticColor, string>> = {
  success: "+",
  destructive: "x",
  warning: "!",
  diffAdded: "+",
  diffRemoved: "-",
  interactionAsk: "?",
  interactionConfirm: "+",
};

/** 取语义令牌的终端颜色（按 NO_COLOR/KCODE_PLAIN/KCODE_THEME 选择） */
export function terminalColor(token: SemanticColor, env?: TerminalEnv): string | undefined {
  if (colorsDisabled(env)) {
    return undefined;
  }
  const palette = readEnv(env)["KCODE_THEME"] === "light" ? TERMINAL_COLORS_LIGHT : TERMINAL_COLORS;
  return palette[token];
}

/** 取语义令牌的无色符号回退（KCODE_PLAIN 时用 ASCII 形态） */
export function terminalSymbol(token: SemanticColor, env?: TerminalEnv): string | undefined {
  if (plainGlyphs(env)) {
    return ASCII_SYMBOLS[token];
  }
  return TERMINAL_SYMBOLS[token];
}

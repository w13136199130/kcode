import { colorsDisabled, plainGlyphs, terminalColor } from "@kcode/design";

/** 语义色 → Ink 颜色（正文前景返回 undefined = 继承终端前景色） */
export const c = terminalColor;

/** 亮色主题下 ANSI 名字面的深色替代（markdown 语法色/灰阶等）
 *  4-03 后续：cyan→teal、blue 提亮一档，避免白底上整屏标题/关键字都是深蓝；
 *  仍满足白底 AA（见 design/test/contrast.test.ts）。 */
const LIGHT_RAW: Record<string, string> = {
  cyan: "#0e7490",
  green: "#15803d",
  yellow: "#b45309",
  magenta: "#7c3aed",
  blue: "#2563eb",
  red: "#dc2626",
  gray: "#64748b",
  grey: "#64748b",
};

/** 3-26：字面量颜色（markdown 语法色/gray 等）同样受 NO_COLOR/KCODE_PLAIN 约束 */
export function rawColor(name: string | undefined): string | undefined {
  if (name === undefined || colorsDisabled()) {
    return undefined;
  }
  if (process.env["KCODE_THEME"] === "light") {
    return LIGHT_RAW[name] ?? name;
  }
  return name;
}

/**
 * 3-26：KCODE_PLAIN=1 时把装饰字形换成 ASCII（颜色已由 terminalColor 关闭）。
 * 只用于状态/结构符，不碰正文与 CJK。
 */
export function glyph(symbol: string, ascii: string, env: NodeJS.ProcessEnv = process.env): string {
  return plainGlyphs(env) ? ascii : symbol;
}

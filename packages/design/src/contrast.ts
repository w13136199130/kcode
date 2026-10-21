/**
 * 3-35：WCAG 对比度工具（终端主题审计用）。
 * 只处理 hex 颜色；ANSI 名不在审计范围（终端实际色值由用户主题决定）。
 */
function channels(hex: string): [number, number, number] {
  const text = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(text)) {
    throw new Error(`不是 6 位 hex 颜色：${hex}`);
  }
  return [
    Number.parseInt(text.slice(0, 2), 16) / 255,
    Number.parseInt(text.slice(2, 4), 16) / 255,
    Number.parseInt(text.slice(4, 6), 16) / 255,
  ];
}

function linear(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map(linear);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG 2.x 对比度（1–21） */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** AA：普通文本 4.5:1，大字号/图形 3:1 */
export function meetsWcagAA(a: string, b: string, large = false): boolean {
  return contrastRatio(a, b) >= (large ? 3 : 4.5);
}

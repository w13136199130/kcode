/** 视觉宽度工具（CJK 双宽；独立模块避免 Transcript ↔ markdown 循环导入） */

export function visualWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    w += ch.codePointAt(0)! > 0xff ? 2 : 1;
  }
  return w;
}

/** 按视觉宽度硬折行（用户消息通栏色块用） */
export function wrapVisual(text: string, width: number): string[] {
  if (text === "") {
    return [""];
  }
  const out: string[] = [];
  let line = "";
  let w = 0;
  for (const ch of text) {
    const cw = ch.codePointAt(0)! > 0xff ? 2 : 1;
    if (w + cw > width && line !== "") {
      out.push(line);
      line = "";
      w = 0;
    }
    line += ch;
    w += cw;
  }
  if (line !== "") {
    out.push(line);
  }
  return out;
}

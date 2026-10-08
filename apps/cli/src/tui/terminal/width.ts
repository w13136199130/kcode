import stringWidth from "string-width";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}
export function previousBoundary(text: string, at: number): number {
  let previous = 0;
  for (const part of segmenter.segment(text)) {
    if (part.index >= at) break;
    previous = part.index;
  }
  return previous;
}
export function nextBoundary(text: string, at: number): number {
  for (const part of segmenter.segment(text)) {
    const end = part.index + part.segment.length;
    if (end > at) return end;
  }
  return text.length;
}

export function visualWidth(text: string): number {
  return stringWidth(text);
}

/** 按视觉宽度硬折行（用户消息通栏色块用） */
export function wrapVisual(text: string, width: number): string[] {
  if (text === "") {
    return [""];
  }
  const out: string[] = [];
  let line = "";
  let w = 0;
  for (const ch of graphemes(text.replace(/\r\n?/g, "\n"))) {
    if (ch === "\n") {
      out.push(line); line = ""; w = 0; continue;
    }
    const cw = visualWidth(ch);
    if (w + cw > Math.max(1, width) && line !== "") {
      out.push(line);
      line = "";
      w = 0;
    }
    line += ch;
    w += cw;
  }
  if (line !== "" || text.endsWith("\n")) {
    out.push(line);
  }
  return out;
}

/** OSC 8 开/闭序列（URL 部分不含 ESC；ST 终止符——links.ts 只发这一种） */
const OSC8_SEQ = /\x1b\]8;;[^\x1b]*\x1b\\/g;
const OSC8_CLOSE = "\x1b]8;;\x1b\\";

/**
 * 按视觉宽度截断（链接感知，N3F-1）：OSC8 序列作零宽单元原样通过，预算只消耗
 * label 文本；截断落在未闭合链接内时补发闭合序列——POC 实测逐簇硬截会拆碎
 * 序列、slice-ansi 会直接丢闭合造成悬空链接（吞掉其后所有输出）。
 */
export function truncateVisual(text: string, columns: number): string {
  let result = "";
  let width = 0;
  let open = false;
  let cut = false;
  let cursor = 0;
  for (const m of text.matchAll(OSC8_SEQ)) {
    const plain = text.slice(cursor, m.index);
    cursor = m.index + m[0].length;
    let truncated = false;
    for (const cluster of graphemes(plain)) {
      const next = visualWidth(cluster);
      if (width + next > columns) {
        truncated = true;
        break;
      }
      result += cluster;
      width += next;
    }
    if (truncated) {
      cut = true;
      break;
    }
    result += m[0];
    open = !open; // 规范成对：open → close 交替
  }
  if (!cut) {
    for (const cluster of graphemes(text.slice(cursor))) {
      const next = visualWidth(cluster);
      if (width + next > columns) {
        cut = true;
        break;
      }
      result += cluster;
      width += next;
    }
  }
  if (cut && open) {
    result += OSC8_CLOSE;
  }
  return result;
}

import stringWidth from "string-width";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function graphemes(text: string): string[] {
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

export function truncateVisual(text: string, columns: number): string {
  let result = "";
  let width = 0;
  for (const cluster of graphemes(text)) {
    const next = visualWidth(cluster);
    if (width + next > columns) break;
    result += cluster; width += next;
  }
  return result;
}

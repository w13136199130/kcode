/**
 * 3-24 输入编辑语义（纯函数，供 InputBox 的 Ctrl+A/E/U/K/W 与按词移动复用）。
 * 词的定义与 readline/Emacs 一致：字母/数字/下划线为词，标点与空白为分隔；
 * 行范围只认 `\n`（Ctrl+A/E/U/K 是行级操作，跨行由词移动负责）。
 */

/** 光标所在行行首（pos 处若正好在换行符上，仍返回该行行首） */
export function lineStart(text: string, at: number): number {
  if (at <= 0) {
    return 0;
  }
  const index = text.lastIndexOf("\n", at - 1);
  return index === -1 ? 0 : index + 1;
}

/** 光标所在行行尾（不含换行符） */
export function lineEnd(text: string, at: number): number {
  const index = text.indexOf("\n", at);
  return index === -1 ? text.length : index;
}

/**
 * 前一个词的起点：先跳过光标前的空白/标点，再退回一个词（不吞词前的分隔符）。
 * 全是分隔符时回到缓冲区开头（Ctrl+W 至少能清掉这些空白）。
 */
export function wordLeft(text: string, at: number): number {
  const prefix = text.slice(0, at).replace(/[^\p{L}\p{N}_]+$/u, "");
  const m = /[\p{L}\p{N}_]+$/u.exec(prefix);
  if (m === null) {
    return 0;
  }
  return prefix.length - m[0].length;
}

/** 下一个词的边界：跳过当前词与随后的分隔符，停在下一词起点（或文末） */
export function wordRight(text: string, at: number): number {
  const suffix = text.slice(at);
  const m = /^[^\p{L}\p{N}_]*[\p{L}\p{N}_]+[^\p{L}\p{N}_]*/u.exec(suffix);
  if (m !== null) {
    return at + m[0].length;
  }
  return text.length;
}

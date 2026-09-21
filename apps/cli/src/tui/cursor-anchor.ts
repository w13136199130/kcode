import { visualWidth } from "./Transcript.js";

/**
 * IME 光标锚定（对标 Claude Code 在 Windows 下的处理）：
 * Ink 每帧渲染后追加换行，真实光标停在「输入行下一行行首」，且光标被隐藏——
 * conhost/终端的 IME 组合窗画在光标处，于是拼音掉到输入行外面。
 *
 * 解法：包装 stdout.write。识别 Ink 的帧写入（以擦除序列 \x1b[2K 开头）：
 * - 写帧前：先把光标落回「帧末下一行行首」（撤销上一次的归位），保证擦除不错位；
 * - 写帧后：把光标挪回输入行末尾（上移一行 + 右移 prompt+内容 视觉宽度列）。
 * 帧间空闲期光标始终停在输入行 → IME 组合窗锚定在 > 提示符后面。
 */

export const inputAnchor = {
  /** 输入行光标列（prompt 2 列 + 内容视觉宽度）；0 = 未激活 */
  column: 0,
  /** 输入行到帧末光标的行距（输入行下方内容行数 + 1）；随菜单开合动态上报 */
  lineOffset: 2,
};

let patched = false;

export function patchStdoutForIme(): void {
  if (patched || process.platform !== "win32" || process.stdout.isTTY !== true) {
    return;
  }
  patched = true;
  const rawWrite = process.stdout.write.bind(process.stdout) as (...args: unknown[]) => boolean;
  const wrapped = (chunk: unknown, ...rest: unknown[]): boolean => {
    const s = typeof chunk === "string" ? chunk : String(chunk);
    if (s.startsWith("\x1b[2K")) {
      // Ink 帧写入：先撤销归位（回帧末下一行行首）让擦除起点正确，写帧后再归位到输入行
      if (inputAnchor.column > 0) {
        rawWrite(`\r\x1b[${inputAnchor.lineOffset}B`);
      }
      const result = rawWrite(chunk, ...rest);
      if (inputAnchor.column > 0) {
        rawWrite(`\x1b[${inputAnchor.lineOffset}A\r\x1b[${inputAnchor.column}C`);
      }
      return result;
    }
    return rawWrite(chunk, ...rest);
  };
  process.stdout.write = wrapped as typeof process.stdout.write;
}

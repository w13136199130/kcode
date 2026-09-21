/**
 * IME 光标锚定 v2（恒定偏移版）：
 * WT/VSCode 终端把 IME 组合串（拼音）画在【真实光标处】——Ink 每帧尾随 '\n'
 * 使光标停在输入框下方，拼音就画到框外。此补丁在每帧写完后把光标挪回输入行内，
 * 组合串随之显示在输入框中（CC 同款行为）。
 *
 * v1 失败原因回顾：菜单在输入行下方导致偏移随菜单高度变化，且与终端滚动互相错位。
 * v2 约束：输入行下方恒为 底部分割线 + 状态栏 共 2 行（菜单已移至上方）→
 * 锚定偏移恒为 3 行，撤销序列恒为下移 3 行。
 */

export const inputAnchor = {
  /** 输入行内光标列（"> " 2 列 + 光标前内容视觉宽度）；0 = 未激活（InputBox 未挂载） */
  column: 0,
};

/** 帧末 → 输入行的恒定行距：底部分割线(1) + 状态栏(1) + Ink 帧尾换行(1)。
 *  布局若在输入行下方增减行，必须同步此值。 */
const LINE_OFFSET = 3;

let patched = false;

export function patchStdoutForIme(): void {
  if (patched || process.platform !== "win32" || process.stdout.isTTY !== true) {
    return;
  }
  patched = true;
  const rawWrite = process.stdout.write.bind(process.stdout) as (
    chunk: unknown,
    ...rest: unknown[]
  ) => boolean;
  const wrapped = (chunk: unknown, ...rest: unknown[]): boolean => {
    const s = typeof chunk === "string" ? chunk : "";
    // Ink 帧写入：log-update 的擦除(\x1b[2K..) 或整屏清除(\x1b[2J) 开头
    const isFrame = s.startsWith("\x1b[2K") || s.startsWith("\x1b[2J");
    if (!isFrame || inputAnchor.column <= 0) {
      return rawWrite(chunk, ...rest);
    }
    // 1) 撤销锚定：从输入行回到帧末行行首，保证 Ink 擦除起点正确
    rawWrite(`\r\x1b[${LINE_OFFSET}B`);
    // 2) 写帧
    const result = rawWrite(chunk, ...rest);
    // 3) 重新锚定：上移到输入行、右移到光标列
    rawWrite(`\x1b[${LINE_OFFSET}A\r\x1b[${inputAnchor.column}C`);
    return result;
  };
  process.stdout.write = wrapped as typeof process.stdout.write;
}

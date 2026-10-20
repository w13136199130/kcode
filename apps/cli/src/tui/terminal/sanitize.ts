/**
 * 3-26 终端安全：不可信文本（模型回复、工具输出、文件名/参数、用户粘贴）渲染前的
 * 控制序列剥离。终端会把 ESC 序列当命令执行——OSC 0 可改窗口标题，OSC 52 可写系统
 * 剪贴板，CSI 可清屏/移动光标；这些都必须挡在 Ink 之前。
 *
 * 保留 `\n` 与 `\t`（排版需要），其余 C0/C1 控制字符与所有 ESC 序列一律去掉。
 * 本函数不保留 OSC 8：自家文件链接在剥离之后由 links.ts 重新生成，顺序不能反。
 */

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

// OSC（ESC ] … BEL / ST）——先剥终止形态，再剥未终止的（恶意串可能吞掉后续输出）
const OSC_TERMINATED = new RegExp(`${ESC}\\][\\s\\S]*?(?:${BEL}|${ESC}\\\\)`, "g");
const OSC_UNTERMINATED = new RegExp(`${ESC}\\][\\s\\S]*$`, "g");
// DCS/SOS/PM/APC（ESC P/X/^/_ … ST）同样可能携带大段数据
const DCS_TERMINATED = new RegExp(`${ESC}[PX^_][\\s\\S]*?(?:${BEL}|${ESC}\\\\)`, "g");
const DCS_UNTERMINATED = new RegExp(`${ESC}[PX^_][\\s\\S]*$`, "g");
// CSI（ESC [ 参数 中间字节 终止字节）
const CSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
// 字符集切换（ESC ( B / ESC ) 0 等三字节形态）先整体剥掉，避免留下尾部字母
const ESC_CHARSET = new RegExp(`${ESC}[()#%][0-9A-Za-z]`, "g");
// 已知双字节 ESC：DECSC/DECRC（7/8）、键区模式（= >）、RIS（c）等
const ESC_DEC = new RegExp(`${ESC}[0-9=>c]`, "g");
// 其余双字节 ESC 序列（Fe 区 @-_）
const ESC_SINGLE = new RegExp(`${ESC}[@-_]`, "g");
// C0（保留 \n \t）+ DEL + C1——用码点拼字符类，避免规则把转义字面量当控制字符
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}` +
    `${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}]`,
  "g",
);

/** 剥离终端控制序列；`\r\n`/`\r` 归一为 `\n` */
export function stripEscapes(text: string): string {
  if (text === "") {
    return text;
  }
  return text
    .replace(/\r\n?/g, "\n")
    .replace(OSC_TERMINATED, "")
    .replace(OSC_UNTERMINATED, "")
    .replace(DCS_TERMINATED, "")
    .replace(DCS_UNTERMINATED, "")
    .replace(CSI, "")
    .replace(ESC_CHARSET, "")
    .replace(ESC_DEC, "")
    .replace(ESC_SINGLE, "")
    .replace(new RegExp(ESC, "g"), "")
    .replace(CONTROL, "");
}

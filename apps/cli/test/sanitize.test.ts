import { describe, expect, it } from "vitest";
import { stripEscapes } from "../src/tui/terminal/sanitize.js";
import { writeTerminalTitle } from "../src/tui/terminal/title.js";

/**
 * 3-26：不可信文本的控制序列剥离。恶意工具输出/模型回复/文件名里的
 * OSC 0（改标题）、OSC 52（写剪贴板）、CSI（清屏/移动光标）都必须变纯文本。
 */

const ESC = "\x1b";
const BEL = "\x07";

describe("stripEscapes", () => {
  it("剥离 OSC 标题与 OSC52 剪贴板写入，保留正文", () => {
    expect(stripEscapes(`安全${ESC}]0;pwned${BEL}文本`)).toBe("安全文本");
    expect(stripEscapes(`a${ESC}]52;c;SGVsbG8=${BEL}b`)).toBe("ab");
  });

  it("剥离 CSI 清屏/光标与 DCS/双字节 ESC 序列", () => {
    expect(stripEscapes(`${ESC}[2J${ESC}[H干净`)).toBe("干净");
    expect(stripEscapes(`x${ESC}Pq#0;2;0;0;0${ESC}\\y`)).toBe("xy");
    expect(stripEscapes(`x${ESC}7y${ESC}8`)).toBe("xy");
  });

  it("未终止的 OSC 一路剥到结尾（防止吞掉后续输出后仍生效）", () => {
    expect(stripEscapes(`${ESC}]0;evil`)).toBe("");
    expect(stripEscapes(`前${ESC}]52;c;AAAA`)).toBe("前");
  });

  it("保留换行/制表，归一 CRLF；剥离 C0/C1 与孤立 ESC", () => {
    expect(stripEscapes("a\r\nb\tc\rd")).toBe("a\nb\tc\nd");
    expect(stripEscapes(`a${ESC}b${String.fromCharCode(8)}c${String.fromCharCode(0x9b)}d`)).toBe("abcd");
  });

  it("自家 OSC8 也不在剥离后保留（链接由 links.ts 在剥离之后重新生成）", () => {
    expect(stripEscapes(`${ESC}]8;;file:///x${ESC}\\label${ESC}]8;;${ESC}\\`)).toBe("label");
  });
});

describe("终端标题写入同样剥离", () => {
  it("恶意文本不能闭合我们的 OSC0 再注入新序列", () => {
    const writes: string[] = [];
    writeTerminalTitle(`evil${BEL}${ESC}]52;c;AAAA${BEL}`, { write: (t) => writes.push(t), isTTY: true }, {});
    expect(writes).toEqual([`${ESC}]0;evil${BEL}`]);
    // 写入体内不存在额外 ESC（只有头尾我们自己的一对）
    const inner = writes[0]!.slice(`${ESC}]0;`.length, -BEL.length);
    expect(inner).not.toContain(ESC);
  });
});

import { describe, expect, it } from "vitest";
import { truncateVisual, visualWidth } from "../src/tui/terminal/width.js";
import { clipVisual, formatFileLink, hyperlinksEnabled, linkifyStructuredPaths, osc8Link } from "../src/tui/terminal/links.js";

const OPEN = (url: string): string => `\x1b]8;;${url}\x1b\\`;
const CLOSE = "\x1b]8;;\x1b\\";
const wrap = (label: string, url: string): string => `${OPEN(url)}${label}${CLOSE}`;
/** 显式开启链接的 env（测试不依赖宿主终端） */
const ON = { KCODE_LINKS: "1" };
const OFF = { KCODE_LINKS: "0" };

describe("N3F-1 宽度回归（POC 结论固化）", () => {
  it("OSC8 序列（ST 终止）零宽——Ink/string-width 计量安全", () => {
    expect(visualWidth(OPEN("file:///E:/x/main.tsx#L10"))).toBe(0);
    expect(visualWidth(CLOSE)).toBe(0);
    expect(visualWidth(wrap("main.tsx", "file:///x"))).toBe(visualWidth("main.tsx"));
  });

  it("truncateVisual：无序列文本行为不变", () => {
    expect(truncateVisual("abcdefgh", 4)).toBe("abcd");
    expect(truncateVisual("中文测试", 4)).toBe("中文");
  });

  it("truncateVisual 链接感知：预算只消耗 label，序列原样通过，截中补闭合", () => {
    const s = wrap("abcdefgh", "file:///x");
    const out = truncateVisual(s, 4);
    expect(out).toBe(`${OPEN("file:///x")}abcd${CLOSE}`);
    expect(visualWidth(out)).toBe(4);
  });

  it("truncateVisual：预算内完整链接不被触碰", () => {
    const s = `pre ${wrap("main.tsx", "file:///x")} post`;
    expect(truncateVisual(s, 40)).toBe(s);
  });

  it("truncateVisual：截断点在链接之后不补闭合", () => {
    const s = `${wrap("ab", "file:///x")}cdefgh`;
    expect(truncateVisual(s, 4)).toBe(`${wrap("ab", "file:///x")}cd`);
  });
});

describe("N3F-1 发射开关（支持面诚实化）", () => {
  it("默认：仅 VS Code 集成终端且 TTY", () => {
    expect(hyperlinksEnabled({ TERM_PROGRAM: "vscode" }, true)).toBe(true);
    expect(hyperlinksEnabled({ TERM_PROGRAM: "vscode" }, false)).toBe(false);
    expect(hyperlinksEnabled({ TERM_PROGRAM: "windows-terminal" }, true)).toBe(false);
    expect(hyperlinksEnabled({}, true)).toBe(false);
  });

  it("KCODE_LINKS=1 手动开（无条件）；=0 强制关（优先于一切）", () => {
    expect(hyperlinksEnabled({ KCODE_LINKS: "1" }, true)).toBe(true);
    expect(hyperlinksEnabled({ KCODE_LINKS: "1" }, false)).toBe(true);
    expect(hyperlinksEnabled({ KCODE_LINKS: "0", TERM_PROGRAM: "vscode" }, true)).toBe(false);
  });
});

describe("N3F-1 formatFileLink", () => {
  it("禁用时退化为（裁剪后的）裸 label", () => {
    expect(formatFileLink("src/a.ts", "src/a.ts", { env: OFF })).toBe("src/a.ts");
    expect(formatFileLink("a".repeat(80), "src/a.ts", { env: OFF, budget: 10 })).toBe("a".repeat(9) + "…");
  });

  it("启用时包 OSC8；相对路径解析为绝对 file:// URL；行号进锚点", () => {
    const out = formatFileLink("src/a.ts", "src/a.ts", { env: ON, line: 10 });
    expect(out.startsWith("\x1b]8;;file://")).toBe(true);
    expect(out).toContain("#L10");
    expect(out.endsWith(CLOSE)).toBe(true);
  });

  it("budget 先裁 label 再包序列（包裹串总宽 = budget；省略号是截断 label 的一部分）", () => {
    const out = formatFileLink("a".repeat(80), "src/a.ts", { env: ON, budget: 10 });
    expect(visualWidth(out)).toBe(10);
    expect(out.endsWith(`a…${CLOSE}`)).toBe(true);
  });

  it("osc8Link 形态", () => {
    expect(osc8Link("L", "u")).toBe(`${OPEN("u")}L${CLOSE}`);
  });

  it("clipVisual 宽度预算带省略号且序列安全（省略号在闭合后）", () => {
    expect(clipVisual("abcdef", 4)).toBe("abc…");
    const wrapped = wrap("abcdef", "file:///x");
    expect(clipVisual(wrapped, 4)).toBe(`${OPEN("file:///x")}abc${CLOSE}…`);
  });
});

describe("N3F-1 结构位链接化（自家常量格式，零误报）", () => {
  it("三段落盘注记：完整日志已保存：<path>；", () => {
    const line = "…（输出共 50000 字符，中间省略；完整日志已保存：E:\\w\\artifacts\\sess_1\\b1.log；以下为末尾）";
    const out = linkifyStructuredPaths(line, ON);
    expect(out).toContain(OPEN("file:///E:/w/artifacts/sess_1/b1.log"));
    expect(out).toContain("E:\\w\\artifacts\\sess_1\\b1.log"); // label 保留原文
    expect(out).toContain("；以下为末尾");
  });

  it("后台任务终态行：· 日志 <path>（行尾）", () => {
    const line = "后台任务 b1 完成：npm test · 日志 E:\\w\\artifacts\\sess_1\\b1.log";
    const out = linkifyStructuredPaths(line, ON);
    expect(out).toContain(OPEN("file:///E:/w/artifacts/sess_1/b1.log"));
  });

  it("不匹配的文本不动；禁用时原样返回", () => {
    const line = "版本 1.2.3 参见 https://x.test/a";
    expect(linkifyStructuredPaths(line, ON)).toBe(line);
    const withPath = "完整日志已保存：E:\\w\\a.log；以下为末尾";
    expect(linkifyStructuredPaths(withPath, OFF)).toBe(withPath);
  });
});

import { describe, expect, it } from "vitest";
import { markdownToLines } from "../src/tui/transcript/markdown.js";

const plain = (lines: ReturnType<typeof markdownToLines>): string[] =>
  lines.map((l) => l.segments.map((s) => s.text).join(""));

describe("markdownToLines（Markdown → 样式分段行）", () => {
  it("标题：一二级加粗青色，三级加粗", () => {
    const lines = markdownToLines("## 标题甲\n\n### 标题乙");
    const texts = plain(lines).filter((t) => t !== "");
    expect(texts).toContain("标题甲");
    expect(texts).toContain("标题乙");
    const h1 = lines.find((l) => l.segments.some((s) => s.text === "标题甲"));
    expect(h1?.segments.some((s) => s.bold === true && s.color === "cyan")).toBe(true);
    const h3 = lines.find((l) => l.segments.some((s) => s.text === "标题乙"));
    expect(h3?.segments.some((s) => s.bold === true && s.color === undefined)).toBe(true);
  });

  it("围栏代码块：识别语言并高亮关键字，▎ 前缀", () => {
    const md = "```ts\nconst x = 1;\n```";
    const lines = markdownToLines(md);
    const codeLines = lines.filter((l) => l.segments.some((s) => s.text.includes("▎")));
    expect(codeLines.length).toBeGreaterThanOrEqual(1);
    const text = codeLines.map((l) => l.segments.map((s) => s.text).join("")).join(" ");
    expect(text).toContain("const");
    expect(text).toContain("x");
    // 关键字着色（magenta）且无内嵌 ANSI 转义
    const kw = codeLines.flatMap((l) => l.segments).find((s) => s.text === "const");
    expect(kw?.color).toBe("magenta");
    expect(lines.some((l) => l.segments.some((s) => s.text.includes("\u001b[")))).toBe(false);
  });

  it("未知语言的代码块原样渲染（无着色、不抛错）", () => {
    const lines = markdownToLines("```xyz-lang\nplain code\n```");
    const text = plain(lines).join("\n");
    expect(text).toContain("plain code");
    expect(text).toContain("▎");
  });

  it("行内样式：粗体/斜体/行内代码/链接", () => {
    const lines = markdownToLines("**粗** 与 *斜* 与 `代码` 与 [站点](https://a.b)");
    const joined = plain(lines).join("");
    expect(joined).toContain("粗");
    expect(joined).toContain("代码");
    expect(joined).toContain("站点");
    expect(joined).toContain("(https://a.b)");
    const segs = lines.flatMap((l) => l.segments);
    expect(segs.some((s) => s.text === "粗" && s.bold === true)).toBe(true);
    expect(segs.some((s) => s.text === "斜" && s.italic === true)).toBe(true);
    expect(segs.some((s) => s.text === "代码" && s.color === "yellow")).toBe(true);
    expect(segs.some((s) => s.text === "站点" && s.color === "cyan")).toBe(true);
    expect(segs.some((s) => s.text === " (https://a.b)" && s.dimColor === true)).toBe(true);
  });

  it("列表：无序圆点、有序编号、任务勾选", () => {
    const lines = markdownToLines("- 甲\n- 乙\n\n1. 第一\n2. 第二\n\n- [x] 完成\n- [ ] 未完");
    const segs = lines.flatMap((l) => l.segments);
    expect(segs.some((s) => s.text === "• " && s.bold === true)).toBe(true);
    expect(segs.some((s) => s.text === "1. ")).toBe(true);
    expect(segs.some((s) => s.text === "2. ")).toBe(true);
    expect(segs.some((s) => s.text === "☑ ")).toBe(true);
    expect(segs.some((s) => s.text === "☐ ")).toBe(true);
    const texts = plain(lines);
    expect(texts.some((t) => t.includes("甲") && t.includes("•"))).toBe(true);
    expect(texts.some((t) => t.includes("第一"))).toBe(true);
  });

  it("引用块：每行 ▎ 前缀", () => {
    const lines = markdownToLines("> 引用一行\n> 引用二行");
    const texts = plain(lines).filter((t) => t.includes("引用"));
    expect(texts.length).toBeGreaterThanOrEqual(2);
    for (const t of texts) {
      expect(t.startsWith("▎")).toBe(true);
    }
  });

  it("GFM 表格：表头加粗 + 对齐分隔行", () => {
    const lines = markdownToLines("| 名称 | 值 |\n| --- | ---: |\n| foo | 1 |");
    const texts = plain(lines);
    const header = texts.find((t) => t.includes("名称"));
    expect(header).toBeDefined();
    const sep = texts.find((t) => t.includes("---"));
    expect(sep).toBeDefined();
    const row = texts.find((t) => t.includes("foo"));
    expect(row).toBeDefined();
    // 表头行加粗
    const headerLine = lines.find((l) => l.segments.some((s) => s.text.includes("名称")));
    expect(headerLine?.segments.every((s) => s.bold === true)).toBe(true);
  });

  it("超宽表格降级为纵向记录，不再把一列撑爆终端", () => {
    const long = "很长的说明".repeat(20);
    const lines = markdownToLines(`| 名称 | 说明 |\n| --- | --- |\n| foo | ${long} |`, { columns: 80 });
    const texts = plain(lines);
    expect(texts.some((t) => t.includes("▎ foo"))).toBe(true);
    expect(texts.some((t) => t.includes("说明:"))).toBe(true);
    expect(texts.some((t) => t.includes("很长的说明"))).toBe(true);
    expect(Math.max(...texts.map((t) => t.length))).toBeLessThan(80);
  });

  it("表格单元格 <br> 转成分隔符，不把内容粘成一串", () => {
    const lines = markdownToLines("| 应用 | 说明 |\n| --- | --- |\n| **cli**<br>apps/cli<br>v0.2.0 | x |", {
      columns: 120,
    });
    const row = plain(lines).find((t) => t.includes("cli"));
    expect(row).toContain("cli · apps/cli · v0.2.0");
    expect(row).not.toContain("cliapps");
  });

  it("6 列表格在终端宽度内降级为纵向记录（字段名来自表头）", () => {
    const md = [
      "| 应用 | 职责 | 入口 | 构建 | 产物 | 说明 |",
      "| --- | --- | --- | --- | --- | --- |",
      "| cli | 终端界面 | main.tsx | tsup | dist | 可分发 |",
      "| host | 子进程宿主 | port.ts | tsup | port.cjs | 被两端消费 |",
    ].join("\n");
    const texts = plain(markdownToLines(md, { columns: 100 }));
    expect(texts.some((t) => t.includes("▎ cli"))).toBe(true);
    expect(texts.some((t) => t.includes("职责: 终端界面"))).toBe(true);
    expect(texts.some((t) => t.includes("▎ host"))).toBe(true);
    expect(texts.some((t) => t.includes("说明: 被两端消费"))).toBe(true);
    expect(texts.some((t) => t.includes("| 应用 |"))).toBe(false);
  });

  it("软换行（br）拆为多行；空文档返回一个空行", () => {
    const lines = markdownToLines("第一行  \n第二行");
    const texts = plain(lines);
    expect(texts.some((t) => t.includes("第一行"))).toBe(true);
    expect(texts.some((t) => t.includes("第二行"))).toBe(true);
    expect(markdownToLines("")).toEqual([{ segments: [] }]);
  });

  it("块级 HTML 剥标签保文本", () => {
    const lines = markdownToLines("<div>包裹文本</div>");
    const joined = plain(lines).join("");
    expect(joined).toContain("包裹文本");
    expect(joined).not.toContain("<div>");
  });

  it("3-26：正文里的 OSC/CSI 控制序列被剥离（含代码块）", () => {
    const evil = "前\u001b]0;pwned\u0007中\u001b[2J后";
    const joined = plain(markdownToLines(evil)).join("");
    expect(joined).toBe("前中后");
    expect(joined).not.toContain("\u001b");

    const code = markdownToLines("```\n\u001b]52;c;AAAA\u0007safe\n```");
    const codeText = plain(code).join("");
    expect(codeText).toContain("safe");
    expect(codeText).not.toContain("\u001b");
  });
});

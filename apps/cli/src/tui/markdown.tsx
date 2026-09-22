import { Lexer } from "marked";
import hljs from "highlight.js/lib/common";
import { visualWidth } from "./width.js";

/**
 * Markdown → 终端渲染行（A-6）：marked 只用其 Lexer 做 token 化，
 * highlight.js 做代码高亮；输出「行 = 样式分段」结构，由 BlockView 映射为
 * Ink <Text color/bold/...>——不内嵌 ANSI 转义串（Ink 的宽度计算与换行
 * 会把转义序列当可见字符，截断即花屏）。
 * 只用于落定的 assistant 块：流式期间按纯文本渲染，避免未闭合围栏导致的结构抖动。
 */

export interface MdSegment {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  dimColor?: boolean;
  strikethrough?: boolean;
}
export interface MdLine {
  segments: MdSegment[];
}

interface InlineStyle {
  color?: string;
  bold?: boolean;
  italic?: boolean;
  dimColor?: boolean;
  strikethrough?: boolean;
}

/** highlight.js 类名（hljs- 前缀已剥）→ Ink 颜色 */
const HLJS_COLORS: Record<string, string> = {
  keyword: "magenta",
  "selector-tag": "magenta",
  doctag: "magenta",
  string: "green",
  char: "green",
  regexp: "green",
  addition: "green",
  tag: "green",
  number: "yellow",
  symbol: "yellow",
  bullet: "yellow",
  meta: "yellow",
  link: "yellow",
  function_: "blue",
  attr: "blue",
  attribute: "blue",
  property: "blue",
  variable: "blue",
  params: "blue",
  operator: "blue",
  selectorAttr: "blue",
  selectorClass: "blue",
  selectorId: "blue",
  built_in: "cyan",
  type: "cyan",
  class_: "cyan",
  typename: "cyan",
  deletion: "red",
};
const HLJS_DIM = new Set(["comment", "quote"]);
const HLJS_BOLD = new Set(["strong", "section"]);
const HLJS_ITALIC = new Set(["emphasis"]);

function hljsStyleFor(classAttr: string): InlineStyle {
  const style: InlineStyle = {};
  for (const token of classAttr.split(/\s+/)) {
    const name = token.replace(/^hljs-/, "");
    const color = HLJS_COLORS[name];
    if (color !== undefined && style.color === undefined) {
      style.color = color;
    } else if (HLJS_DIM.has(name)) {
      style.dimColor = true;
    } else if (HLJS_BOLD.has(name)) {
      style.bold = true;
    } else if (HLJS_ITALIC.has(name)) {
      style.italic = true;
    }
  }
  return style;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
};
function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (e) => ENTITIES[e] ?? e);
}

/** hljs 的 HTML 输出 → 分段（span 样式栈、实体解码；段内 \n 由 splitSegments 按行拆） */
function hljsToSegments(html: string, base: InlineStyle): MdSegment[] {
  const segments: MdSegment[] = [];
  const stack: InlineStyle[] = [base];
  const re = /<span class="([^"]*)">|<\/span>/g;
  let last = 0;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    if (m.index > last) {
      segments.push({ text: decodeEntities(html.slice(last, m.index)), ...stack[stack.length - 1]! });
    }
    if (m[1] !== undefined) {
      stack.push({ ...stack[stack.length - 1]!, ...hljsStyleFor(m[1]) });
    } else {
      stack.pop();
    }
    last = re.lastIndex;
  }
  if (last < html.length) {
    segments.push({ text: decodeEntities(html.slice(last)), ...stack[stack.length - 1]! });
  }
  return segments;
}

/** 代码块高亮：识别语言则高亮，否则原样 */
function highlightCode(code: string, lang?: string): MdSegment[] {
  const langId = lang?.trim().split(/\s+/)[0]?.toLowerCase();
  if (langId !== undefined && langId !== "" && hljs.getLanguage(langId)) {
    try {
      return hljsToSegments(hljs.highlight(code, { language: langId, ignoreIllegals: true }).value, {});
    } catch {
      // 高亮失败退化为原样
    }
  }
  return [{ text: code }];
}

/** 段内含 \n 时拆为多行 */
function splitSegments(segments: MdSegment[]): MdLine[] {
  const lines: MdLine[] = [{ segments: [] }];
  for (const seg of segments) {
    const parts = seg.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        lines.push({ segments: [] });
      }
      if (parts[i] !== "") {
        lines[lines.length - 1]!.segments.push({
          text: parts[i]!,
          ...(seg.color !== undefined ? { color: seg.color } : {}),
          ...(seg.bold !== undefined ? { bold: seg.bold } : {}),
          ...(seg.italic !== undefined ? { italic: seg.italic } : {}),
          ...(seg.dimColor !== undefined ? { dimColor: seg.dimColor } : {}),
          ...(seg.strikethrough !== undefined ? { strikethrough: seg.strikethrough } : {}),
        });
      }
    }
  }
  return lines;
}

type AnyToken = {
  type: string;
  text?: string;
  lang?: string;
  depth?: number;
  href?: string;
  title?: string | null;
  tokens?: AnyToken[];
  items?: AnyToken[];
  ordered?: boolean;
  start?: string | number;
  task?: boolean;
  checked?: boolean;
  loose?: boolean;
  header?: { text: string; tokens: AnyToken[] }[];
  rows?: { text: string; tokens: AnyToken[] }[][];
  align?: Array<"center" | "left" | "right" | null>;
};

/** Markdown 主入口：文档 → 渲染行（空文档返回一个空行） */
export function markdownToLines(md: string): MdLine[] {
  const out: MdLine[] = [];
  const lastIsEmpty = (): boolean =>
    out.length === 0 || out[out.length - 1]!.segments.every((s) => s.text.trim() === "");
  const blank = (): void => {
    if (out.length > 0 && !lastIsEmpty()) {
      out.push({ segments: [] });
    }
  };

  /** 内联 token 遍历：追加到 lines 的当前（最后）行；br 开新行 */
  function inlineSegments(tokens: AnyToken[] | undefined, style: InlineStyle, lines: MdLine[]): void {
    for (const token of tokens ?? []) {
      switch (token.type) {
        case "text":
        case "escape":
          if (token.tokens !== undefined && token.tokens.length > 0) {
            inlineSegments(token.tokens, style, lines);
          } else {
            appendSeg(lines, { text: token.text ?? "", ...style });
          }
          break;
        case "strong":
          inlineSegments(token.tokens, { ...style, bold: true }, lines);
          break;
        case "em":
          inlineSegments(token.tokens, { ...style, italic: true }, lines);
          break;
        case "del":
          inlineSegments(token.tokens, { ...style, strikethrough: true }, lines);
          break;
        case "codespan":
          appendSeg(lines, { text: token.text ?? "", color: style.color ?? "yellow" });
          break;
        case "br":
          lines.push({ segments: [] });
          break;
        case "link": {
          const startLine = lines.length - 1;
          inlineSegments(token.tokens, { ...style, color: "cyan" }, lines);
          const href = token.href ?? "";
          const label = lines
            .slice(startLine)
            .flatMap((l) => l.segments.map((s) => s.text))
            .join("");
          if (href !== "" && href !== label && !label.includes(href)) {
            appendSeg(lines, { text: ` (${href})`, dimColor: true });
          }
          break;
        }
        case "image":
          appendSeg(lines, {
            text: `[图片: ${token.text ?? ""}${token.href ? ` ${token.href}` : ""}]`,
            dimColor: true,
          });
          break;
        case "html":
        case "tag":
          appendSeg(lines, { text: (token.text ?? "").replace(/<[^>]*>/g, ""), ...style });
          break;
        default:
          if (token.tokens !== undefined) {
            inlineSegments(token.tokens, style, lines);
          } else if (token.text !== undefined) {
            appendSeg(lines, { text: token.text, ...style });
          }
      }
    }
  }

  function appendSeg(lines: MdLine[], segment: MdSegment): void {
    if (lines.length === 0) {
      lines.push({ segments: [] });
    }
    // 文本 token 可含软换行（引用块多行、段落内换行）：按 \n 拆行，样式随行
    const parts = segment.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        lines.push({ segments: [] });
      }
      if (parts[i] !== "") {
        lines[lines.length - 1]!.segments.push({
          text: parts[i]!,
          ...(segment.color !== undefined ? { color: segment.color } : {}),
          ...(segment.bold !== undefined ? { bold: segment.bold } : {}),
          ...(segment.italic !== undefined ? { italic: segment.italic } : {}),
          ...(segment.dimColor !== undefined ? { dimColor: segment.dimColor } : {}),
          ...(segment.strikethrough !== undefined ? { strikethrough: segment.strikethrough } : {}),
        });
      }
    }
  }

  function inlineToLines(tokens: AnyToken[] | undefined, style: InlineStyle): MdLine[] {
    const lines: MdLine[] = [{ segments: [] }];
    inlineSegments(tokens, style, lines);
    return lines;
  }

  function renderInlineBlock(tokens: AnyToken[] | undefined, style: InlineStyle, prefix?: MdSegment): void {
    for (const line of inlineToLines(tokens, style)) {
      out.push({ segments: prefix !== undefined ? [prefix, ...line.segments] : line.segments });
    }
  }

  function renderCode(code: string, lang: string | undefined, indent: string): void {
    blank();
    const segments = highlightCode(code.replace(/\n$/, ""), lang);
    for (const line of splitSegments(segments)) {
      out.push({ segments: [{ text: `${indent}▎ `, dimColor: true }, ...line.segments] });
    }
    blank();
  }

  function renderTable(token: AnyToken): void {
    blank();
    const headerCells = (token.header ?? []).map((cell) => inlineToLines(cell.tokens, { bold: true }));
    const rowCells = (token.rows ?? []).map((row) => row.map((cell) => inlineToLines(cell.tokens, {})));
    const flat = (lines: MdLine[]): string => lines.flatMap((l) => l.segments.map((s) => s.text)).join("");
    const widths = (token.header ?? []).map((_, c) =>
      Math.max(visualWidth(flat(headerCells[c]!)), ...rowCells.map((row) => visualWidth(flat(row[c]!)))),
    );
    const pad = (text: string, w: number, align: "center" | "left" | "right" | null): string => {
      const gap = Math.max(0, w - visualWidth(text));
      if (align === "right") {
        return " ".repeat(gap) + text;
      }
      if (align === "center") {
        const left = Math.floor(gap / 2);
        return " ".repeat(left) + text + " ".repeat(gap - left);
      }
      return text + " ".repeat(gap);
    };
    const emitRow = (cells: MdLine[][], style: InlineStyle): void => {
      out.push({
        segments: cells.map((cell, c) => ({
          text: ` ${pad(flat(cell), widths[c]!, token.align?.[c] ?? null)} `,
          ...style,
        })),
      });
    };
    emitRow(headerCells, { bold: true });
    out.push({
      segments: widths.map((w) => ({ text: ` ${"-".repeat(w + 2)}`, dimColor: true })),
    });
    for (const row of rowCells) {
      emitRow(row, {});
    }
    blank();
  }

  function walkBlocks(tokens: AnyToken[], prefix: MdSegment | undefined, indent: string): void {
    for (const token of tokens) {
      switch (token.type) {
        case "space":
          blank();
          break;
        case "heading": {
          blank();
          const style: InlineStyle = (token.depth ?? 1) <= 2 ? { bold: true, color: "cyan" } : { bold: true };
          renderInlineBlock(token.tokens, style);
          blank();
          break;
        }
        case "hr":
          blank();
          out.push({ segments: [{ text: "─".repeat(40), dimColor: true }] });
          break;
        case "code":
          renderCode(token.text ?? "", token.lang, indent);
          break;
        case "paragraph":
          renderInlineBlock(token.tokens, {}, prefix);
          break;
        case "blockquote": {
          blank();
          const start = out.length;
          walkBlocks(token.tokens ?? [], prefix, `${indent}  `);
          for (let i = start; i < out.length; i++) {
            out[i]!.segments.unshift({ text: "▎ ", dimColor: true });
          }
          break;
        }
        case "list": {
          blank();
          const startNum = Number.parseInt(String(token.start ?? ""), 10);
          (token.items ?? []).forEach((item, idx) => {
            const n = Number.isFinite(startNum) ? startNum + idx : idx + 1;
            const firstPrefix: MdSegment = {
              text: token.ordered ? `${n}. ` : item.task ? (item.checked ? "☑ " : "☐ ") : "• ",
              bold: !token.ordered,
              ...(prefix ? { color: "cyan" } : {}),
            };
            if (item.loose === true) {
              let first = true;
              for (const child of item.tokens ?? []) {
                if (child.type === "text") {
                  renderInlineBlock(
                    child.tokens ?? [{ type: "text", text: child.text ?? "" }],
                    {},
                    first ? firstPrefix : undefined,
                  );
                } else if (child.type === "space") {
                  blank();
                } else {
                  walkBlocks([child], first ? firstPrefix : undefined, indent);
                }
                first = false;
              }
            } else {
              const inline = (item.tokens ?? []).flatMap((t) =>
                t.type === "text" ? (t.tokens ?? [t]) : [t],
              );
              renderInlineBlock(inline, {}, firstPrefix);
              for (const child of item.tokens ?? []) {
                if (child.type === "list") {
                  walkBlocks([child], undefined, `${indent}  `);
                } else if (child.type === "code") {
                  renderCode(child.text ?? "", child.lang, `${indent}  `);
                }
              }
            }
          });
          break;
        }
        case "table":
          renderTable(token);
          break;
        case "html":
          renderInlineBlock(
            [{ type: "text", text: (token.text ?? "").replace(/<[^>]*>/g, " ").trim() }],
            {},
            prefix,
          );
          break;
        case "text":
          renderInlineBlock(token.tokens ?? [{ type: "text", text: token.text ?? "" }], {}, prefix);
          break;
        default:
          if (token.tokens !== undefined) {
            renderInlineBlock(token.tokens, {}, prefix);
          }
      }
    }
  }

  walkBlocks(Lexer.lex(md) as unknown as AnyToken[], undefined, "");
  if (out.length === 0) {
    out.push({ segments: [] });
  }
  return out;
}

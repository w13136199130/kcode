import { useMemo, type ReactNode } from "react";

/**
 * 轻量 Markdown 渲染（N3-3）：代码块/行内代码/粗体/链接/列表——不引入外部库。
 * CLI 侧用 marked+highlight.js（N2-3 之前已做）；Web 侧从零实现等价的最小渲染。
 */

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <>{blocks}</>;
}

function parseBlocks(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // 代码块 ```
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        code.push(lines[i]!);
        i++;
      }
      i++; // skip closing ```
      nodes.push(
        <div key={key++} style={codeBlockStyle}>
          {lang !== "" && (
            <div style={{ fontSize: "12px", color: "var(--kcode-foreground-subtle)", marginBottom: "4px" }}>{lang}</div>
          )}
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: "13px" }}>
            {code.join("\n")}
          </pre>
        </div>,
      );
      continue;
    }

    // 列表 - / * / 数字.
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]!) || /^\s*\d+\.\s+/.test(lines[i]!))) {
        items.push(lines[i]!.replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i++;
      }
      nodes.push(
        <ul key={key++} style={{ margin: "4px 0 8px 20px", lineHeight: 1.6 }}>
          {items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
        </ul>,
      );
      continue;
    }

    // 空行跳过
    if (line.trim() === "") {
      i++;
      continue;
    }

    // 普通段落（连续行合并）
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !lines[i]!.startsWith("```") && !/^\s*[-*]\s+/.test(lines[i]!)) {
      para.push(lines[i]!);
      i++;
    }
    nodes.push(
      <p key={key++} style={{ margin: "4px 0 8px", lineHeight: 1.6 }}>
        {para.map((l, j) => <span key={j}>{renderInline(l)}{j < para.length - 1 ? <br /> : null}</span>)}
      </p>,
    );
  }

  return nodes;
}

/** 行内渲染：`code` / **bold** / [link](url) */
function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("`")) {
      parts.push(
        <code key={key++} style={inlineCodeStyle}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("[")) {
      const linkMatch = /\[([^\]]+)\]\(([^)]+)\)/.exec(token);
      if (linkMatch !== null) {
        parts.push(
          <a key={key++} href={linkMatch[2]} target="_blank" rel="noopener noreferrer" style={{ color: "var(--kcode-brand)" }}>
            {linkMatch[1]}
          </a>,
        );
      }
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

const codeBlockStyle: React.CSSProperties = {
  margin: "8px 0",
  padding: "12px",
  background: "var(--kcode-bg-subtle)",
  borderRadius: "6px",
  border: "1px solid var(--kcode-border)",
  overflow: "auto",
};

const inlineCodeStyle: React.CSSProperties = {
  padding: "2px 6px",
  background: "var(--kcode-bg-subtle)",
  borderRadius: "4px",
  fontFamily: "monospace",
  fontSize: "0.9em",
};

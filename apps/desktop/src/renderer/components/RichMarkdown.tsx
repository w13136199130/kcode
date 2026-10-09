import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { highlightCode } from "../lib/highlight.js";

/**
 * 富 Markdown 渲染（M4，桌面专用）：代码块（Shiki 异步高亮 + 语言标签 + 复制按钮）、
 * 标题/列表/引用/分隔线/段落 + 行内（粗体/行内代码/链接）。
 * 未闭合代码围栏按流式容错处理（直播区传入未完成文本时）。
 */
export function RichMarkdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <>{blocks}</>;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (lang === "") return;
    void highlightCode(code, lang).then((h) => {
      if (!cancelled) setHtml(h);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  const copy = (): void => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{lang !== "" ? lang : "text"}</span>
        <button type="button" className="md-code-copy" onClick={copy} title="复制代码">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      {html !== null ? (
        <div className="md-code-body shiki-host" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="md-code-body">{code}</pre>
      )}
    </div>
  );
}

function parseBlocks(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        code.push(lines[i]!);
        i++;
      }
      i++; // 收尾 ```（流式未闭合时自然到底）
      nodes.push(<CodeBlock key={key++} lang={lang} code={code.join("\n")} />);
      continue;
    }

    if (/^#{1,4}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      nodes.push(
        <div key={key++} className={`md-h${level}`}>
          {renderInline(line.replace(/^#+\s*/, ""))}
        </div>,
      );
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      const ordered = /^\s*\d+\.\s+/.test(line);
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]!) || /^\s*\d+\.\s+/.test(lines[i]!))) {
        items.push(lines[i]!.replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i++;
      }
      const List = ordered ? "ol" : "ul";
      nodes.push(
        <List key={key++} className="md-list">
          {items.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </List>,
      );
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i++;
      }
      nodes.push(
        <blockquote key={key++} className="md-quote">
          {renderInline(quote.join(" "))}
        </blockquote>,
      );
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      nodes.push(<hr key={key++} className="md-hr" />);
      i++;
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    // 段落：连续非空行合并
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(```|#{1,4}\s|\s*[-*]\s|\s*\d+\.\s|\s*>)/.test(lines[i]!)) {
      para.push(lines[i]!);
      i++;
    }
    nodes.push(
      <p key={key++} className="md-p">
        {renderInline(para.join("\n"))}
      </p>,
    );
  }
  return nodes;
}

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let key = 0;
  // 顺序：行内代码 → 粗体 → 链接
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const t = m[0];
    if (t.startsWith("`")) out.push(<code key={key++}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("**")) out.push(<strong key={key++}>{t.slice(2, -2)}</strong>);
    else {
      const label = t.slice(1, t.indexOf("]"));
      const href = t.slice(t.indexOf("(") + 1, -1);
      out.push(
        <a key={key++} href={href} target="_blank" rel="noreferrer">
          {label}
        </a>,
      );
    }
    last = idx + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

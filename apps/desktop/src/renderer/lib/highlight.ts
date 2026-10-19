import type { Highlighter } from "shiki";

/**
 * Shiki 单例（M4）：动态 import + 惰性建器——首帧纯文本渲染、高亮异步补齐
 * （zcode 双轨渲染同款策略）。语言集按 kcode 日常最小集；未列语言回退纯文本。
 */
let highlighterPromise: Promise<Highlighter> | null = null;

const LANGS = ["typescript", "javascript", "json", "bash", "markdown", "css", "html", "python", "diff"] as const;
const THEME = "one-dark-pro" as const;

export function getHighlighter(): Promise<Highlighter> {
  if (highlighterPromise === null) {
    highlighterPromise = (async () => {
      const shiki = await import("shiki");
      return shiki.createHighlighter({
        themes: [THEME],
        langs: [...LANGS],
      });
    })();
  }
  return highlighterPromise;
}

/** 代码 → 高亮 HTML（语言未装载/高亮器未就绪时返回 null，调用方回落纯文本） */
export async function highlightCode(code: string, lang: string): Promise<string | null> {
  try {
    const hl = await getHighlighter();
    const loaded = hl.getLoadedLanguages();
    const alias: Record<string, string> = { ts: "typescript", js: "javascript", sh: "bash", shell: "bash", py: "python", md: "markdown" };
    const resolved = alias[lang.toLowerCase()] ?? lang.toLowerCase();
    if (!loaded.includes(resolved as never)) return null;
    return hl.codeToHtml(code, { lang: resolved, theme: THEME });
  } catch {
    return null;
  }
}

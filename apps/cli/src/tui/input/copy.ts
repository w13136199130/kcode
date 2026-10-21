import type { Block } from "@kcode/ui";
import { stripEscapes } from "../terminal/sanitize.js";

/** 3-34：最后一个 assistant 正文（/copy 默认目标） */
export function lastAssistantText(blocks: readonly Block[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind === "assistant" && block.text.trim() !== "") {
      return stripEscapes(block.text);
    }
  }
  return null;
}

/** 取一段 Markdown 里最后一个围栏代码块（含语言标签的正文） */
export function lastCodeBlockOf(text: string): { lang: string; code: string } | null {
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let last: { lang: string; code: string } | null = null;
  for (const match of text.matchAll(re)) {
    last = { lang: (match[1] ?? "").trim(), code: match[2] ?? "" };
  }
  return last;
}

/** 3-34：从最近的 assistant 消息向前找最后一个代码块（/copy code） */
export function lastCodeBlock(blocks: readonly Block[]): { lang: string; code: string } | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind !== "assistant") continue;
    const found = lastCodeBlockOf(block.text);
    if (found !== null && found.code.trim() !== "") {
      return { lang: found.lang, code: stripEscapes(found.code) };
    }
  }
  return null;
}

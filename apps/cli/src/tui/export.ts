import type { Block } from "@kcode/ui";

/**
 * 会话导出（N3I-6）：转写块 → Markdown。纯函数可单测；
 * 工具输出截断 200 字符（导出是给人看的摘要，不是取证——全文在 JSONL）。
 */

/** 工具输出在导出中的截断长度 */
const OUTPUT_LIMIT = 200;

export function blocksToMarkdown(blocks: Block[]): string {
  const lines: string[] = ["# kcode 会话导出", ""];
  for (const block of blocks) {
    switch (block.kind) {
      case "banner":
        lines.push(`> ${block.model} · ${block.cwd}`, "");
        break;
      case "user":
        lines.push("## 🧑 用户", "", block.text, "");
        break;
      case "assistant":
        lines.push("## 🤖 助手", "", block.text, "");
        break;
      case "reasoning":
        lines.push(`> 💭 ${truncate(block.text.split("\n")[0] ?? "", OUTPUT_LIMIT)}`, "");
        break;
      case "tool": {
        const status = block.status === "done" ? "✓" : block.status === "failed" ? "✗" : "⏳";
        lines.push(`> 🔧 \`${block.tool}\` ${block.argsPreview} ${status}${block.summary !== undefined ? ` ${block.summary}` : ""}`);
        if (block.output !== undefined && block.output !== "") {
          lines.push(`> ${truncate(block.output.replace(/\n/g, " ⏎ "), OUTPUT_LIMIT)}`);
        }
        lines.push("");
        break;
      }
      case "info": {
        const icon = block.tone === "ok" ? "✓" : block.tone === "deny" ? "✗" : block.tone === "warn" ? "⚠" : "ℹ";
        lines.push(`> ${icon} ${block.text}`, "");
        break;
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

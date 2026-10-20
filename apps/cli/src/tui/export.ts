import type { SessionEvent } from "@kcode/contracts";
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

/** 3-06：JSONL 事件流原样序列化（工具输出不截断） */
export function serializeEvents(events: readonly SessionEvent[]): string {
  return `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

/**
 * 3-06：事件流 → Markdown。以 JSONL 为事实源，工具结果全文入 fenced block；
 * 不再从 TUI 转写块反推（块里工具输出本来就截断过）。
 */
export function eventsToMarkdown(events: readonly SessionEvent[]): string {
  const lines: string[] = ["# kcode 会话导出", ""];
  const toolCalls = new Map<string, { tool: string; args: unknown }>();
  for (const event of events) {
    switch (event.type) {
      case "session_start":
        lines.push(`> 会话 ${event.sessionId} · 模型 ${event.model}${event.cwd !== undefined ? ` · ${event.cwd}` : ""}`, "");
        break;
      case "user_message":
        lines.push("## 🧑 用户", "", event.content, "");
        break;
      case "assistant_message":
        if (event.reasoning !== undefined && event.reasoning !== "") {
          lines.push("<details><summary>💭 思考过程</summary>", "", event.reasoning, "", "</details>", "");
        }
        lines.push("## 🤖 助手", "", event.content, "");
        break;
      case "tool_call":
        toolCalls.set(event.callId, { tool: event.tool, args: event.args });
        lines.push(`### 🔧 ${event.tool}`, "", "```json", JSON.stringify(event.args, null, 2), "```", "");
        break;
      case "tool_result": {
        const call = toolCalls.get(event.callId);
        lines.push(`> ${event.ok ? "✓" : "✗"} ${call?.tool ?? event.callId}${event.error !== undefined ? `：${event.error}` : ""}`, "");
        if (event.output !== "") {
          lines.push("```text", event.output, "```", "");
        }
        break;
      }
      case "compaction_summary":
        lines.push(`> ⑂ 上下文压缩（${event.dropped} 条）：${event.summary}`, "");
        break;
      case "session_end":
        lines.push(`> 本轮结束：${event.reason}${event.detail !== undefined ? `（${event.detail}）` : ""}`, "");
        break;
      case "llm_error":
        lines.push(`> ⚠ 模型错误：${event.error}`, "");
        break;
      default:
        break;
    }
  }
  return `${lines.join("\n")}\n`;
}

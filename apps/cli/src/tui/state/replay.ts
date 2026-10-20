import type { SessionEvent } from "@kcode/contracts";
import type { Block } from "@kcode/ui";
import { SUBAGENT_NOTIFICATION_HEADER } from "@kcode/session";
import { formatToolPreview } from "../transcript/Transcript.js";

/** 转写回放上限：完整历史仍在 JSONL/模型上下文里，UI 只保留最近一段 */
const MAX_REPLAY_BLOCKS = 120;

/**
 * 3-01：JSONL 事件流 → 转写块（resume 后不再空白）。
 * 只还原用户/助手/工具/压缩/错误；todo/subagent 状态卡不重放（当前态由后续事件重建）。
 */
export function replayBlocks(events: readonly SessionEvent[]): Block[] {
  const blocks: Block[] = [];
  const toolIndex = new Map<string, number>();
  for (const event of events) {
    switch (event.type) {
      case "user_message":
        if (event.content.startsWith(SUBAGENT_NOTIFICATION_HEADER)) {
          blocks.push({ kind: "info", text: `📩 ${event.content.split("\n").slice(1).join("\n")}` });
        } else {
          blocks.push({
            kind: "user",
            text: event.content,
            ...(event.images !== undefined && event.images.length > 0 ? { images: event.images } : {}),
          });
        }
        break;
      case "assistant_message":
        if (event.reasoning !== undefined && event.reasoning !== "") {
          blocks.push({ kind: "reasoning", text: event.reasoning });
        }
        blocks.push({ kind: "assistant", text: event.content });
        break;
      case "tool_call": {
        toolIndex.set(event.callId, blocks.length);
        blocks.push({
          kind: "tool",
          callId: event.callId,
          tool: event.tool,
          argsPreview: formatToolPreview(event.tool, event.args),
          status: "running",
        });
        break;
      }
      case "tool_result": {
        const index = toolIndex.get(event.callId);
        if (index === undefined) break;
        const previous = blocks[index];
        if (previous?.kind !== "tool") break;
        const full = event.output !== "" ? event.output : (event.error ?? "");
        blocks[index] = {
          ...previous,
          status: event.ok ? "done" : "failed",
          summary: full.split("\n")[0]?.slice(0, 120) ?? "",
          output: full.slice(0, 2_000),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        };
        break;
      }
      case "compaction_summary":
        blocks.push({ kind: "info", text: `⑂ ${event.summary}` });
        break;
      case "run_limit_reached":
        blocks.push({ kind: "info", tone: "warn", text: `⏸ 已达单轮步数上限（${event.maxTurns} 步）` });
        break;
      case "llm_error":
        blocks.push({ kind: "info", tone: "warn", text: `✗ 模型调用失败：${event.error}` });
        break;
      default:
        break;
    }
  }
  if (blocks.length <= MAX_REPLAY_BLOCKS) return blocks;
  const omitted = blocks.length - MAX_REPLAY_BLOCKS;
  return [
    { kind: "info", text: `… 已省略前 ${omitted} 块（完整记录见 JSONL / /export）` },
    ...blocks.slice(-MAX_REPLAY_BLOCKS),
  ];
}

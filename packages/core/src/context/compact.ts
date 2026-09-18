import type { ChatMessage } from "@kcode/contracts";
import { exceedsBudget, type Budget } from "./budget.js";

export interface CompactionOutcome {
  history: ChatMessage[];
  summary: string;
  dropped: number;
}

/**
 * 压缩（§5.2）：由 context 决定时机、session 提供历史并写回摘要事件（回放可见）。
 * P0 策略：超预算时丢弃中段 tool 消息、保留首尾；P2 换 LLM 摘要式压缩。
 */
export function compactHistory(
  history: ChatMessage[],
  budget: Budget,
): CompactionOutcome | null {
  if (!exceedsBudget(history, budget) || history.length < 5) return null;
  const keepHead = 2;
  const keepTail = 2;
  const middle = history.slice(keepHead, history.length - keepTail);
  const dropped = middle.filter((m) => m.role === "tool").length;
  if (dropped === 0) return null;
  const summary = `[compacted] dropped ${dropped} tool results to fit token budget`;
  return {
    history: [
      ...history.slice(0, keepHead),
      { role: "assistant", content: summary },
      ...history.slice(history.length - keepTail),
    ],
    summary,
    dropped,
  };
}

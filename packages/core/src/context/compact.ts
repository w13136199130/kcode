import type { ChatMessage } from "@kcode/contracts";
import { exceedsBudget, type Budget } from "./budget.js";

/** 触发压缩的最小历史条数：更短的历史压缩无收益 */
export const COMPACTION_MIN_MESSAGES = 8;

/** 压缩时原文保留的近期消息条数：保证最新上下文不失真（B3：6→10，窗口预算放大后保留更多近因） */
export const COMPACTION_KEEP_TAIL = 10;

export interface CompactionPlan {
  /** 进入摘要区的较早消息 */
  toSummarize: ChatMessage[];
  /** 原文保留的近期消息 */
  keepTail: ChatMessage[];
  /** 任务锚点：首条用户消息。多次压缩后仍保留任务目标原文，防止目标漂移 */
  taskAnchor: ChatMessage | undefined;
}

export interface CompactionResult {
  /** 摘要正文（模型生成或降级占位） */
  summary: string;
  /** 被折叠的消息条数 */
  dropped: number;
}

/**
 * 计算压缩方案：历史超预算且足够长时，切分为「待摘要区 + 近期保留区」。
 * force=true 跳过预算判定（/compact 手动压缩），仍保留最短历史守卫。
 */
export function planCompaction(history: ChatMessage[], budget: Budget, force = false): CompactionPlan | null {
  if ((!force && !exceedsBudget(history, budget)) || history.length < COMPACTION_MIN_MESSAGES) {
    return null;
  }
  const keepTail = history.slice(history.length - COMPACTION_KEEP_TAIL);
  const toSummarize = history.slice(0, history.length - COMPACTION_KEEP_TAIL);
  const taskAnchor = history.find((m) => m.role === "user");
  return { toSummarize, keepTail, taskAnchor };
}

/**
 * 应用压缩结果：以「任务锚点 + 额外锚点 + 摘要占位消息 + 近期原文」替换原历史。
 * 摘要占位使用 assistant 角色，与在线会话、回放还原保持同一形态。
 * 额外锚点（B3）：已批准的执行计划等跨压缩必须保真的上下文。
 */
export function applyCompaction(
  plan: CompactionPlan,
  summary: string,
  extraAnchors: ChatMessage[] = [],
): { history: ChatMessage[]; dropped: number } {
  const anchors: ChatMessage[] = [];
  if (plan.taskAnchor !== undefined && !plan.keepTail.includes(plan.taskAnchor)) {
    anchors.push(plan.taskAnchor);
  }
  for (const anchor of extraAnchors) {
    if (!anchors.includes(anchor) && !plan.keepTail.includes(anchor)) {
      anchors.push(anchor);
    }
  }
  return {
    history: [...anchors, { role: "assistant", content: summary }, ...plan.keepTail],
    dropped: plan.toSummarize.length,
  };
}

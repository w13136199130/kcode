import type { ChatMessage, HookPreOutcome, HookRunner } from "@kcode/contracts";
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
  /** 头部折叠条数（= toSummarize.length）：落盘供回放重建「首用户锚点 + 摘要 + 尾部」 */
  covered: number;
}

/**
 * 计算压缩方案：历史超预算且足够长时，切分为「待摘要区 + 近期保留区」。
 * force=true 跳过预算判定（/compact 手动压缩），仍保留最短历史守卫。
 */
export function planCompaction(
  history: ChatMessage[],
  budget: Budget,
  force = false,
  measuredTokens?: number,
): CompactionPlan | null {
  // measuredTokens（provider 校准值）优先——压缩判据用真实占用而非纯估算；
  // 未提供时退 exceedsBudget 的全量估算
  const over = measuredTokens !== undefined ? measuredTokens > budget.history : exceedsBudget(history, budget);
  if ((!force && !over) || history.length < COMPACTION_MIN_MESSAGES) {
    return null;
  }
  // 保留区起点默认取末尾 KEEP_TAIL 条；若落在 tool 消息上，向左回退到它所属的
  // assistant(toolCalls)，避免把工具结果与其调用拆到两个区，产生孤立 tool result。
  let split = Math.max(0, history.length - COMPACTION_KEEP_TAIL);
  while (split > 0 && history[split]?.role === "tool") {
    split--;
  }
  const toSummarize = history.slice(0, split);
  if (toSummarize.length === 0) {
    // 历史太短、没有可折叠的完整轮次：宁可不压缩，也不制造孤立 tool result
    return null;
  }
  const keepTail = history.slice(split);
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

/**
 * 压缩编排（自 loop.ts 外迁，N2-5）：计划 → pre_compact 钩子门 → 摘要（缺省计数占位）→ 应用。
 * 返回新历史与结果；无需压缩/被钩子否决时返回 null。
 */
export async function runCompaction(
  history: ChatMessage[],
  budget: Budget,
  force: boolean,
  deps: {
    sessionId: string;
    summarizer?: { summarize(input: { messages: ChatMessage[] }): Promise<string> };
    pinnedAnchor?: ChatMessage;
    gatePreCompact: (
      invoke: (hooks: HookRunner) => Promise<HookPreOutcome> | undefined,
    ) => Promise<HookPreOutcome>;
    /** 实测占用（provider usage 校准）：优先于内部估算触发判定 */
    measuredTokens?: number;
  },
): Promise<{ summary: string; dropped: number; covered: number; history: ChatMessage[] } | null> {
  const plan = planCompaction(history, budget, force, deps.measuredTokens);
  if (plan === null) {
    return null;
  }
  // pre_compact 钩子（B5）：退出码 2 = 跳过本次压缩
  const gate = await deps.gatePreCompact((h) =>
    h.onPreCompact?.({ sessionId: deps.sessionId, dropped: plan.toSummarize.length }),
  );
  if (gate.veto) {
    return null;
  }
  const summary: string =
    deps.summarizer !== undefined
      ? await deps.summarizer.summarize({ messages: plan.toSummarize })
      : `【历史压缩】已折叠 ${plan.toSummarize.length} 条较早消息（未配置摘要器，仅保留任务与近期上下文）`;
  const applied = applyCompaction(plan, summary, deps.pinnedAnchor !== undefined ? [deps.pinnedAnchor] : []);
  return { summary, dropped: applied.dropped, covered: plan.toSummarize.length, history: applied.history };
}

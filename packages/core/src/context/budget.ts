import type { ChatMessage } from "@kcode/contracts";
import { estimateTokens } from "@kcode/shared";

/** token 预算管理（§5.2 / B3）：system/history/tool-result 配额随模型上下文窗口派生 */
export interface Budget {
  system: number;
  history: number;
  toolResult: number;
}

export const DEFAULT_BUDGET: Budget = { system: 4096, history: 100_000, toolResult: 8192 };

/**
 * 模型上下文窗口提示（按模型族静态表；未识别回退 128k）。
 * 运行时探测（providers 能力协商）落地后替换为探测值。
 */
const MODEL_WINDOW_HINTS: { re: RegExp; window: number }[] = [
  { re: /deepseek-v4|deepseek-flash/i, window: 1_000_000 },
  { re: /deepseek/i, window: 128_000 },
  { re: /glm-5|glm-4(\.\d)?/i, window: 128_000 },
  { re: /kimi|moonshot/i, window: 128_000 },
  { re: /qwen/i, window: 131_072 },
];

export const DEFAULT_CONTEXT_WINDOW = 128_000;

export function contextWindowFor(model: string): number {
  for (const hint of MODEL_WINDOW_HINTS) {
    if (hint.re.test(model)) {
      return hint.window;
    }
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * 由上下文窗口派生预算：history 取 60%（早压——社区实践共识：接近上限才压会频繁打断任务），
 * 为系统提示/工具 schema/输出留余量；toolResult 8k 对应 micro 截断线。
 */
export function deriveBudget(contextWindow: number): Budget {
  return {
    system: 4096,
    history: Math.floor(contextWindow * 0.6),
    toolResult: 8192,
  };
}

export function historyTokens(history: ChatMessage[]): number {
  return history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

export function exceedsBudget(history: ChatMessage[], budget: Budget): boolean {
  return historyTokens(history) > budget.history;
}

/**
 * micro 压缩（B3）：工具结果回灌历史前截断——保留头 60% + 尾 25%，中部以标记替代。
 * 会话事件仍保留完整输出（JSONL）；只有发给模型的副本被截断。
 */
export function capToolResult(text: string, budget: Budget): string {
  const tokens = estimateTokens(text);
  if (tokens <= budget.toolResult) {
    return text;
  }
  // 按估算比例换算字符额度（CJK 混排取 1.6 字符/token 的折中系数）
  const maxChars = Math.floor(budget.toolResult * 1.6);
  const head = Math.floor(maxChars * 0.6);
  const tail = Math.floor(maxChars * 0.25);
  return `${text.slice(0, head)}\n…［已截断：中间内容省略，原文 ${text.length} 字符约 ${tokens} tok，头尾各保留一部分］\n${text.slice(-tail)}`;
}

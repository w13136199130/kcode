import type { ChatMessage } from "@kcode/contracts";
import { estimateTokens } from "@kcode/shared";

/** token 预算管理（§5.2）：system/skills/history/tool-result 各自配额，超限触发压缩 */
export interface Budget {
  system: number;
  history: number;
  toolResult: number;
}

export const DEFAULT_BUDGET: Budget = { system: 4096, history: 100_000, toolResult: 8192 };

export function historyTokens(history: ChatMessage[]): number {
  return history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

export function exceedsBudget(history: ChatMessage[], budget: Budget): boolean {
  return historyTokens(history) > budget.history;
}

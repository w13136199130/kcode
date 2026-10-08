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

/** 窗口是否命中静态表（/context 据此注记"按默认估算"——静默回退曾让小众大窗模型被冤枉早压） */
export function modelWindowKnown(model: string): boolean {
  return MODEL_WINDOW_HINTS.some((hint) => hint.re.test(model));
}

/** 输出预留（zcode 同款结论：窗口是输入输出共享，压缩只能让出输入侧；上限 21k） */
export const OUTPUT_RESERVE_TOKENS = 21_000;
/** 压缩缓冲：摘要生成本身 + 响应的余量（绝对值——这两项开销不随窗口缩放） */
export const COMPACT_BUFFER_TOKENS = 13_000;

/**
 * 由上下文窗口派生预算（对齐批修订：早压→晚压）。
 * 旧式 history = 窗口×60% 的比例预留在大窗上压缩过早、小窗上余量失真；
 * 预留物（输出侧/摘要/缓冲）都是绝对 token 量，公式改为 窗口 − 绝对预留。
 * 落点：128k→73% 触发、200k→83%、1M→97%（CC ~83%、zcode 窗口−34k 同区间）。
 * 守卫：预留不超过窗口一半（极小窗口不至于无历史可用）。
 */
export function deriveBudget(contextWindow: number): Budget {
  const reserve = Math.min(OUTPUT_RESERVE_TOKENS + COMPACT_BUFFER_TOKENS, Math.floor(contextWindow / 2));
  return {
    system: 4096,
    history: Math.max(0, contextWindow - reserve),
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
 * N2-3 ToolEntry：预算按工具收紧（definition.resultBudget），缺省由调用方传全局 toolResult。
 */
export function capToolResult(text: string, toolResultBudget: number): string {
  const tokens = estimateTokens(text);
  if (tokens <= toolResultBudget) {
    return text;
  }
  // 按估算比例换算字符额度（CJK 混排取 1.6 字符/token 的折中系数）
  const maxChars = Math.floor(toolResultBudget * 1.6);
  const head = Math.floor(maxChars * 0.6);
  const tail = Math.floor(maxChars * 0.25);
  return `${text.slice(0, head)}\n…［已截断：中间内容省略，原文 ${text.length} 字符约 ${tokens} tok，头尾各保留一部分］\n${text.slice(-tail)}`;
}

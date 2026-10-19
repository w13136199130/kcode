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

export function exceedsBudget(history: ChatMessage[], budget: Budget): boolean {
  return historyTokens(history) > budget.history;
}

/**
 * micro 压缩（B3）：工具结果回灌历史前截断——保留头 ~70% + 尾 ~30%，中部以标记替代。
 * 会话事件仍保留完整输出（JSONL）；只有发给模型的副本被截断。
 * N2-3 ToolEntry：预算按工具收紧（definition.resultBudget），缺省由调用方传全局 toolResult。
 *
 * 预算必须按 `estimateTokens` 真正二分，不能用 `budget * 1.6` 反推字符数：
 * ASCII 约 3.8 字符/token、CJK 约 0.75 token/字，同一系数会让 ASCII 只用掉 ~42%
 * 预算、CJK 反而超 20%。这里是"发给模型的副本"的硬上限，宁可多留有效内容。
 */
export function capToolResult(text: string, toolResultBudget: number): string {
  const tokens = estimateTokens(text);
  if (tokens <= toolResultBudget) {
    return text;
  }
  const marker = `\n…［已截断：中间内容省略，原文 ${text.length} 字符约 ${tokens} tok；可用 offset/分页读取剩余部分］\n`;
  let best = "";
  let lo = 0;
  let hi = text.length;
  while (lo <= hi) {
    const keep = Math.floor((lo + hi) / 2);
    const headChars = Math.floor(keep * 0.7);
    const tailChars = keep - headChars;
    const candidate = `${text.slice(0, headChars)}${marker}${tailChars > 0 ? text.slice(-tailChars) : ""}`;
    if (estimateTokens(candidate) <= toolResultBudget) {
      best = candidate;
      lo = keep + 1;
    } else {
      hi = keep - 1;
    }
  }
  // 极低预算连完整标记都放不下：至少给一个可识别的截断标记，避免返回空串。
  // （例如 resultBudget=5 的护栏测试；内容全部舍弃，但模型必须知道发生了截断。）
  return best !== "" ? best : "已截断";
}

/** 单张图片的 token 估算（provider 未回报时压缩判据用；按常见视觉模型偏保守取 1k） */
export const IMAGE_TOKEN_ESTIMATE = 1_024;

/**
 * 历史 token 估算：除正文外，必须计入 assistant 的 toolCalls.args 与用户附图。
 * 否则 write 一次写入 50k token 文件、或用户发 3 张图，压缩判据完全看不见——
 * 直到端点 400 才暴露（contextStats 的 provider 校准只在有 usage 时覆盖）。
 */
export function historyTokens(history: ChatMessage[]): number {
  let total = 0;
  for (const message of history) {
    total += estimateTokens(message.content);
    if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
      try {
        total += estimateTokens(JSON.stringify(message.toolCalls.map((call) => call.args)));
      } catch {
        // 理论不可达（args 来自 JSON）；异常时不为估算中断整轮
      }
    }
    total += (message.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE;
  }
  return total;
}

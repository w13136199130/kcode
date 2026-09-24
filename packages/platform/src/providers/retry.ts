/**
 * LLM 瞬态失败重试（§A-4）：429/限流与网络抖动不再打断整轮会话。
 *
 * 策略（清洁重试）：仅当本次尝试尚未向下游吐出任何内容（无 text/reasoning/tool_call）
 * 时重试——重放的响应从头生成，任何一层（历史/JSONL/TUI 流式缓冲）都不会出现半截拼接。
 * 已出内容后的失败不重试（半截内容无法回收，宁可报错让上层可见）。
 *
 * 分类不依赖 @ai-sdk/provider 类型（其为传递依赖）：按结构走 cause 链取 statusCode，
 * 消息按网络错误码/限流文案匹配；AbortError 与确定性 4xx 永不重试。
 */

export interface LlmRetryOptions {
  /** 最大重试次数（总尝试 = 1 + maxRetries）；0 关闭重试 */
  maxRetries?: number;
  /** 退避基数（毫秒）：delay = min(max, base * 2^attempt) + 抖动 */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 测试注入；生产为真实 setTimeout */
  sleep?: (ms: number) => Promise<void>;
  /** 每次重试的回调（调用方写日志） */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

export const DEFAULT_LLM_RETRY: Required<Pick<LlmRetryOptions, "maxRetries" | "baseDelayMs" | "maxDelayMs">> = {
  maxRetries: 3,
  baseDelayMs: 600,
  maxDelayMs: 15_000,
};

/** 网络类瞬态失败的消息特征（Node fetch 包装为 "fetch failed"，真实错误在 cause.code） */
const RETRYABLE_MESSAGE_RE =
  /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE|EHOSTUNREACH|ENETUNREACH|socket hang up|network error|Too Many Requests|Service Unavailable|Bad Gateway|Gateway Timeout|overloaded/i;

interface ErrorChainInfo {
  messages: string[];
  statusCode?: number;
  retryAfterMs?: number;
  aborted: boolean;
}

/** 沿 cause 链（≤4 层）收集错误消息、statusCode 与 Retry-After（AI SDK 的 APICallError 带这些字段） */
function errorChain(err: unknown): ErrorChainInfo {
  const info: ErrorChainInfo = { messages: [], aborted: false };
  let current: unknown = err;
  for (let depth = 0; current !== undefined && current !== null && depth < 4; depth++) {
    if (typeof current === "string") {
      info.messages.push(current);
      break;
    }
    if (typeof current !== "object") {
      break;
    }
    if (current instanceof Error) {
      info.messages.push(current.message);
      if (current.name === "AbortError") {
        info.aborted = true;
        break;
      }
    }
    const record = current as { statusCode?: unknown; responseHeaders?: unknown; cause?: unknown };
    if (info.statusCode === undefined && typeof record.statusCode === "number") {
      info.statusCode = record.statusCode;
    }
    if (info.retryAfterMs === undefined && record.responseHeaders !== null && typeof record.responseHeaders === "object") {
      const retryAfter = (record.responseHeaders as Record<string, unknown>)["retry-after"];
      if (typeof retryAfter === "string" && /^\d+$/.test(retryAfter.trim())) {
        info.retryAfterMs = Number(retryAfter.trim()) * 1000;
      }
    }
    current = record.cause;
  }
  return info;
}

/** 是否值得重试：用户中断 → 否；限流(429/408)/5xx → 是；其他确定性 4xx → 否；无状态码时按消息特征判定 */
export function isRetryableLlmError(err: unknown): boolean {
  const info = errorChain(err);
  if (info.aborted) {
    return false;
  }
  if (info.statusCode !== undefined) {
    return info.statusCode === 408 || info.statusCode === 429 || info.statusCode >= 500;
  }
  return info.messages.some((m) => RETRYABLE_MESSAGE_RE.test(m));
}

/** 退避延迟：优先服务端 Retry-After，否则指数退避 + 抖动；上限 60s */
export function computeBackoffMs(attempt: number, err: unknown, opts: LlmRetryOptions = {}): number {
  const base = opts.baseDelayMs ?? DEFAULT_LLM_RETRY.baseDelayMs;
  const max = opts.maxDelayMs ?? DEFAULT_LLM_RETRY.maxDelayMs;
  const { retryAfterMs } = errorChain(err);
  if (retryAfterMs !== undefined) {
    return Math.min(Math.max(retryAfterMs, base), 60_000);
  }
  const exp = Math.min(max, base * 2 ** attempt);
  return exp + Math.floor(Math.random() * 250);
}

/** 可中断的 sleep：用户 Esc 中断时不让退避等待拖住响应 */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    if (ms <= 0 || signal?.aborted) {
      resolvePromise();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolvePromise();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

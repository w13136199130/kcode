/**
 * 3-20：上下文溢出识别。不同 OpenAI 兼容端点的错误措辞不统一，
 * 只认稳定特征串；命中后 loop 强制 compact 并重试一次。
 */
const CONTEXT_OVERFLOW =
  /(context[_ ]length|context window|maximum context|prompt is too long|too many tokens|input is too long|exceeds? the maximum|token limit|上下文.{0,6}(超|上限|过长))/i;

export function isContextOverflowError(message: string): boolean {
  return CONTEXT_OVERFLOW.test(message);
}

/**
 * S2-3：LLM 错误结构化分类（发射侧唯一权威）。供应商措辞不统一，按稳定特征串归类；
 * 识别不了的归 unknown——消费方（桌面 banner/CLI 提示）据此分流而不是再猜文案。
 */
export function classifyLlmError(message: string): "quota" | "auth" | "rate_limit" | "context_overflow" | "network" | "unknown" {
  if (isContextOverflowError(message)) return "context_overflow";
  const text = message.toLowerCase();
  if (/insufficient[\s_-]?(quota|balance|funds|credit)|exceeded your current quota|quota[\s_-]?exceeded|billing[\s_-]?(hard[\s_-]?error|issue|required)|credit[\s_-]?(balance|limit)|balance[\s_-]?too[\s_-]?low|1112|402|余额不足|欠费|额度(不足|已用尽|用尽|耗尽)/.test(text)) {
    return "quota";
  }
  if (/(api[\s_-]?key|invalid[\s_-]?token|unauthorized|401|authentication|鉴权失败|密钥)/.test(text)) return "auth";
  if (/(rate[\s_-]?limit|429|too many requests|请求过于频繁|触发限流)/.test(text)) return "rate_limit";
  if (/(fetch failed|econnrefused|econnreset|enotfound|etimedout|socket hang up|network|断网|连接超时)/.test(text)) return "network";
  return "unknown";
}

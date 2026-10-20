/**
 * 3-20：上下文溢出识别。不同 OpenAI 兼容端点的错误措辞不统一，
 * 只认稳定特征串；命中后 loop 强制 compact 并重试一次。
 */
const CONTEXT_OVERFLOW =
  /(context[_ ]length|context window|maximum context|prompt is too long|too many tokens|input is too long|exceeds? the maximum|token limit|上下文.{0,6}(超|上限|过长))/i;

export function isContextOverflowError(message: string): boolean {
  return CONTEXT_OVERFLOW.test(message);
}

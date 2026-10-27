/**
 * P4-2（F16）：额度类 LLM 错误识别与「重置额度」跳转映射。
 * 供应商文案不统一（bigmodel 1112 余额不足 / OpenAI exceeded your current quota /
 * Anthropic billing_hard_error…），按关键词+错误码分类；纯 429 限流（可重试瞬态）
 * 不算额度错误。误判代价只是多显示一个 banner，宁可略宽松。
 */
export function isQuotaError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    /insufficient[\s_-]?(quota|balance|funds|credit)/.test(lower) ||
    /exceeded your current quota/.test(lower) ||
    /quota[\s_-]?exceeded/.test(lower) ||
    /billing[\s_-]?(hard[\s_-]?error|issue|required)/.test(lower) ||
    /credit[\s_-]?(balance|limit)/.test(lower) ||
    /balance[\s_-]?too[\s_-]?low/.test(lower) ||
    /\b1112\b/.test(lower) ||
    /\b402\b/.test(lower) ||
    /余额不足|欠费|额度(不足|已用尽|用尽|耗尽)/.test(message)
  );
}

/** 已知厂商的充值/额度管理页；provider id 取自模型引用前缀（providerId/modelId）。 */
const PROVIDER_BILLING_URLS: Record<string, string> = {
  bigmodel: "https://open.bigmodel.cn/finance/overview",
  glm: "https://open.bigmodel.cn/finance/overview",
  zhipu: "https://open.bigmodel.cn/finance/overview",
  openai: "https://platform.openai.com/settings/organization/billing",
  anthropic: "https://console.anthropic.com/settings/billing",
  deepseek: "https://platform.deepseek.com/usage",
  moonshot: "https://platform.moonshot.cn/console/account",
};

/** 未知厂商返回 null——调用方回落到打开设置（换 key/供应商是额度问题的真实出路）。 */
export function quotaResetUrl(modelRef: string): string | null {
  const providerId = modelRef.split("/")[0] ?? "";
  return PROVIDER_BILLING_URLS[providerId.toLowerCase()] ?? null;
}

/** 反馈动作：把诊断信息（错误/模型/会话/时间）拼成一段可粘贴的文本。 */
export function quotaFeedbackText(opts: { error: string; model: string | null; sessionId: string | null }): string {
  return [
    "kcode 额度错误反馈",
    `时间：${new Date().toISOString()}`,
    `模型：${opts.model ?? "—"}`,
    `会话：${opts.sessionId ?? "—"}`,
    `错误：${opts.error}`,
  ].join("\n");
}

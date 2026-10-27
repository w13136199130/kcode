import { useCallback } from "react";
import { quotaFeedbackText, quotaResetUrl } from "../lib/quota.js";

/**
 * P4-2（F16）：额度 banner 动作——「重置额度」开已知厂商充值页（window.open 经主进程
 * https 校验后交系统浏览器），未知厂商回落设置页（换 key/供应商是额度问题的真实出路）；
 * 「反馈」复制诊断信息（错误/模型/会话），供用户粘贴到反馈渠道。
 */
export function useQuotaActions(opts: {
  modelDefault: string | null;
  sessionId: string | null;
  openSettings: () => void;
}): { quotaReset: () => void; quotaFeedback: (error: string) => void } {
  const quotaReset = useCallback((): void => {
    const url = quotaResetUrl(opts.modelDefault ?? "");
    if (url !== null) {
      window.open(url, "_blank", "noopener");
      return;
    }
    opts.openSettings();
  }, [opts.modelDefault, opts.openSettings]);
  const quotaFeedback = useCallback(
    (error: string): void => {
      const text = quotaFeedbackText({ error, model: opts.modelDefault, sessionId: opts.sessionId });
      void navigator.clipboard?.writeText(text).catch(() => undefined);
    },
    [opts.modelDefault, opts.sessionId],
  );
  return { quotaReset, quotaFeedback };
}

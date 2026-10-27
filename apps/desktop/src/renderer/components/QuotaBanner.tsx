import { useEffect, useRef, useState } from "react";

/**
 * P4-2（F16）：额度错误内联 banner——「重置额度」（已知厂商开充值页，否则回落设置）
 * 与「反馈」（复制诊断信息，供用户粘贴到反馈渠道）。落在时间线行内，随转写持久化。
 */
export function QuotaBanner({
  text,
  onReset,
  onFeedback,
}: {
  text: string;
  onReset: () => void;
  onFeedback: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <div className="row-quota">
      <div className="row-quota-title">💳 额度不足，本次模型调用被拒绝</div>
      <div className="row-quota-detail">{text}</div>
      <div className="row-quota-actions">
        <button type="button" className="quota-reset" onClick={onReset}>
          重置额度
        </button>
        <button
          type="button"
          className="quota-feedback"
          onClick={() => {
            onFeedback(text);
            setCopied(true);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 2500);
          }}
        >
          {copied ? "已复制错误信息" : "反馈"}
        </button>
      </div>
    </div>
  );
}

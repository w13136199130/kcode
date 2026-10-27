import { RotateCcw } from "lucide-react";

/**
 * S1-3：普通 LLM 失败 banner（网络/超时/5xx 等）——失败可见且有一键出口：
 * 「重试本轮」= 重发失败前的最后一轮用户输入（提交走既有队列语义，运行中会排队）。
 */
export function FailedCallBanner({
  error,
  retryText,
  onRetry,
}: {
  error: string;
  retryText?: string;
  onRetry?: (text: string) => void;
}) {
  return (
    <div className="row-llm-failed">
      <div className="llm-failed-title">✗ 模型调用失败</div>
      <div className="llm-failed-detail">{error}</div>
      {retryText !== undefined && onRetry !== undefined ? (
        <div className="llm-failed-actions">
          <button type="button" className="llm-retry" onClick={() => onRetry(retryText)}>
            <RotateCcw size={12} strokeWidth={1.8} />
            重试本轮
          </button>
        </div>
      ) : null}
    </div>
  );
}

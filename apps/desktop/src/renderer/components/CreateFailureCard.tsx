import type { CreateFailure } from "../lib/switch-guards.js";

export function CreateFailureCard(props: {
  failure: CreateFailure;
  onRetry(): void;
  onResumePrevious(): void;
}) {
  return (
    <div className="create-failure" role="alert">
      <div className="cf-title">⚠ 创建会话失败</div>
      <div className="cf-msg">{props.failure.error}</div>
      <div className="cf-actions">
        <button type="button" className="cf-btn" onClick={props.onRetry}>
          重试
        </button>
        {props.failure.previousSessionId !== null ? (
          <button type="button" className="cf-btn ghost" onClick={props.onResumePrevious}>
            恢复上一个任务
          </button>
        ) : null}
      </div>
    </div>
  );
}

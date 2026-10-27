import type { PausePoint } from "./projection.js";

/**
 * P4-2（F16）：暂停点「继续」条——单轮步数到顶 / 会话预算暂停时出现在 Composer 上方，
 * 点击即发送「继续」（与既有 CLI 语义一致：历史保留，接着做）。
 */
export function ContinueBar({ paused, onContinue }: { paused: PausePoint; onContinue: () => void }) {
  const hint =
    paused.reason === "limit"
      ? `⏸ 已达单轮步数上限${paused.maxTurns !== undefined ? `（${paused.maxTurns} 步）` : ""}，可继续接着做`
      : `⏸ ${paused.detail ?? "会话 token 预算已用尽"}`;
  return (
    <div className="continue-bar">
      <span className="continue-hint">{hint}</span>
      <button type="button" className="continue-btn" onClick={onContinue}>
        继续
      </button>
    </div>
  );
}

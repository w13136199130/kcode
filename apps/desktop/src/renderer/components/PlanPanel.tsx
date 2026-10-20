import { RichMarkdown } from "./RichMarkdown.js";

/**
 * 计划批准面板（D0-06）：plan_submit → plan/request → 用户批准/继续研究/放弃。
 * 批准后 host 侧 composition 自动切回执行模式；这里只负责把 verdict 回传。
 */
export function PlanPanel(props: {
  plan: string;
  onRespond(verdict: "approved" | "revise" | "abandon"): void;
}) {
  return (
    <div className="ask-panel plan-panel">
      <div className="ask-title">📋 执行计划（等待批准）</div>
      <div className="plan-body">
        <RichMarkdown text={props.plan} />
      </div>
      <div className="ask-actions">
        <button type="button" className="ask-btn allow" onClick={() => props.onRespond("approved")}>
          批准并执行
        </button>
        <button type="button" className="ask-btn" onClick={() => props.onRespond("revise")}>
          继续研究
        </button>
        <button type="button" className="ask-btn deny" onClick={() => props.onRespond("abandon")} autoFocus>
          放弃
        </button>
      </div>
    </div>
  );
}

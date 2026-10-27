import type { Row, TimelineState } from "./projection.js";
import { Timeline } from "./Timeline.js";
import { ContinueBar } from "./ContinueBar.js";
import { RuntimeProgressCard } from "./RuntimeProgressCard.js";

/**
 * P4-2（F16）：运行态三件套的组合入口——时间线 + 右上浮动进度卡 + 暂停「继续」条。
 * 抽成组合件避免 main.tsx 膨胀；进度卡与继续条的显隐逻辑内聚在此。
 */
export function RuntimeTimeline({
  timeline,
  model,
  onOpenDiff,
  onQuotaReset,
  onQuotaFeedback,
  onContinue,
}: {
  timeline: TimelineState;
  model?: string | null;
  onOpenDiff?: (row: Extract<Row, { kind: "tool" }>) => void;
  onQuotaReset?: () => void;
  onQuotaFeedback?: (text: string) => void;
  onContinue: () => void;
}) {
  return (
    <>
      <RuntimeProgressCard todos={timeline.todos} agents={timeline.agents} busy={timeline.busy} />
      <Timeline
        state={timeline}
        model={model}
        onOpenDiff={onOpenDiff}
        onQuotaReset={onQuotaReset}
        onQuotaFeedback={onQuotaFeedback}
      />
      {timeline.paused !== null && !timeline.busy ? (
        <ContinueBar paused={timeline.paused} onContinue={onContinue} />
      ) : null}
    </>
  );
}

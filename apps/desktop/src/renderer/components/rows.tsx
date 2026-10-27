import { memo } from "react";
import { RichMarkdown } from "./RichMarkdown.js";
import type { Row } from "./projection.js";
import { ToolCallRowView } from "./ToolCallRow.js";
import { QuotaBanner } from "./QuotaBanner.js";
import { FailedCallBanner } from "./FailedCallBanner.js";

/**
 * 时间线行分发器（M2a）：按行类型 memo 化渲染（zcode ConversationRowView 减法版）。
 * 助手正文走 web 端 Markdown（流式容错未闭合语法由直播区承担——落定行总是完整文本）。
 * S0-5：真正包上 memo——投影更新时未变行保持对象引用，配合稳定的行内回调
 * （useWorkspacePanes/useQuotaActions 均 useCallback）即可跳过未变行重渲染。
 */

export const RowView = memo(function RowView({
  row,
  model,
  onOpenDiff,
  onQuotaReset,
  onQuotaFeedback,
  onRetryFailed,
}: {
  row: Row;
  model?: string | null;
  onOpenDiff?: (row: Extract<Row, { kind: "tool" }>) => void;
  onQuotaReset?: () => void;
  onQuotaFeedback?: (text: string) => void;
  onRetryFailed?: (text: string) => void;
}) {  switch (row.kind) {
    case "user":
      return (
        <div className="row-user">
          <div className="row-user-label">你</div>
          <div className="row-user-text">{row.text}</div>
          {row.at !== undefined ? <div className="row-user-time">{formatTime(row.at)} · 你</div> : null}
        </div>
      );
    case "assistant":
      return (
        <div className="row-assistant">
          <div className="assistant-meta">
            <span className="assistant-brand">kcode</span>
            {model !== null && model !== undefined && model !== "" ? <span>{model}</span> : null}
            {row.at !== undefined ? <span>{formatTime(row.at)}</span> : null}
          </div>
          <RichMarkdown text={row.text} />
        </div>
      );
    case "thinking":
      return (
        <details className="row-thinking">
          <summary>💭 思考过程</summary>
          <pre>{row.text}</pre>
        </details>
      );
    case "tool":
      return <ToolCallRowView row={row} onOpenDiff={onOpenDiff} />;
    case "info":
      return <div className={`row-info tone-${row.tone ?? "plain"}`}>{row.text}</div>;
    case "todo":
      return (
        <div className="row-todo">
          {row.todos.map((todo, idx) => (
            <div key={`${idx}-${todo.content}`} className={`row-todo-item status-${todo.status}`}>
              {todo.status === "completed" ? "☑" : todo.status === "in_progress" ? "◐" : "☐"} {todo.content}
            </div>
          ))}
        </div>
      );
    case "separator":
      return <div className="row-separator">{row.label}</div>;
    case "quota":
      return (
        <QuotaBanner
          text={row.text}
          onReset={() => onQuotaReset?.()}
          onFeedback={(text) => onQuotaFeedback?.(text)}
        />
      );
    case "llm_failed":
      return <FailedCallBanner error={row.error} retryText={row.retryText} onRetry={onRetryFailed} />;
  }
});

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

import { Markdown } from "@web/components/Markdown.js";
import type { Row } from "./projection.js";
import { ToolCallRowView } from "./ToolCallRow.js";

/**
 * 时间线行分发器（M2a）：按行类型 memo 化渲染（zcode ConversationRowView 减法版）。
 * 助手正文走 web 端 Markdown（流式容错未闭合语法由直播区承担——落定行总是完整文本）。
 */

export function RowView({ row }: { row: Row }) {
  switch (row.kind) {
    case "user":
      return (
        <div className="row-user">
          <div className="row-user-text">{row.text}</div>
        </div>
      );
    case "assistant":
      return (
        <div className="row-assistant">
          <Markdown text={row.text} />
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
      return <ToolCallRowView row={row} />;
    case "info":
      return <div className={`row-info tone-${row.tone ?? "plain"}`}>{row.text}</div>;
    case "separator":
      return <div className="row-separator">{row.label}</div>;
  }
}

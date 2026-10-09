import type { Row } from "./projection.js";

/**
 * Diff 查看器（M3b，Side Pane）：edit/write 的完整变更视图——
 * unified +/- 行（Shiki 语法高亮留后续；轻量首帧策略同 zcode）。
 */
export function DiffViewer({ row }: { row: Extract<Row, { kind: "tool" }> }) {
  const args = (row.args ?? {}) as Record<string, unknown>;
  const path = typeof args["path"] === "string" ? args["path"] : "(未知文件)";
  const oldText = typeof args["oldString"] === "string" ? args["oldString"] : undefined;
  const newText = typeof args["newString"] === "string" ? args["newString"] : undefined;
  const content = typeof args["content"] === "string" ? args["content"] : undefined;

  const lines: Array<{ sign: "+" | "-" | " "; text: string }> = [];
  if (oldText !== undefined && newText !== undefined) {
    for (const l of oldText.split("\n")) lines.push({ sign: "-", text: l });
    for (const l of newText.split("\n")) lines.push({ sign: "+", text: l });
  } else if (content !== undefined) {
    for (const l of content.split("\n")) lines.push({ sign: "+", text: l });
  }

  const added = lines.filter((l) => l.sign === "+").length;
  const removed = lines.filter((l) => l.sign === "-").length;

  return (
    <div className="diff-viewer">
      <div className="diff-file">
        <code>{path}</code>
        <span className="diff-stat">
          <span className="stat-add">+{added}</span> <span className="stat-del">-{removed}</span>
        </span>
      </div>
      <pre className="tool-diff">
        {lines.map((l, i) => (
          <div key={i} className={`diff-line ${l.sign === "+" ? "diff-added" : l.sign === "-" ? "diff-removed" : ""}`}>
            {l.sign}
            {l.text}
          </div>
        ))}
      </pre>
      {row.status === "running" ? <div className="tool-meta">执行中…</div> : null}
      {row.error !== undefined && row.error !== "" ? <div className="tool-error">{row.error}</div> : null}
    </div>
  );
}

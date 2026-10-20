import type { Row } from "./projection.js";

type DiffLine = { sign: "+" | "-" | " "; text: string };

function parsePreview(diff: string): DiffLine[] {
  return diff.split("\n").map((line) => {
    const sign = line.startsWith("+") ? "+" : line.startsWith("-") ? "-" : " ";
    return { sign, text: sign === " " ? line.replace(/^ /, "") : line.slice(1) };
  });
}

/**
 * Diff 查看器（M3b，Side Pane；D2-04 改为真实数据）：
 * - 优先使用 host 生成的 `row.preview`（write 已对比磁盘旧内容，LCS 生成）；
 * - 没有 preview 时，edit 在 renderer 内按 LCS 对拍 old/new；
 * - write 没有 preview 时明确标注“旧内容不可用”，不再伪装成全新增。
 */
export function DiffViewer({ row }: { row: Extract<Row, { kind: "tool" }> }) {
  const args = (row.args ?? {}) as Record<string, unknown>;
  const path =
    row.preview?.path ??
    (typeof args["path"] === "string" ? args["path"] : "(未知文件)");
  const lines: DiffLine[] = row.preview !== undefined ? parsePreview(row.preview.diff) : fallbackLines(args);
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
      {row.preview === undefined && isWrite(args) ? (
        <div className="diff-note dim">旧文件内容不可用（host 未生成 preview）——仅显示新内容</div>
      ) : null}
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

function isWrite(args: Record<string, unknown>): boolean {
  return typeof args["content"] === "string" && typeof args["oldString"] !== "string";
}

function fallbackLines(args: Record<string, unknown>): DiffLine[] {
  const oldText = typeof args["oldString"] === "string" ? args["oldString"] : undefined;
  const newText = typeof args["newString"] === "string" ? args["newString"] : undefined;
  const content = typeof args["content"] === "string" ? args["content"] : undefined;
  if (oldText !== undefined && newText !== undefined) return lcsDiff(oldText.split("\n"), newText.split("\n"));
  if (content !== undefined) return content.split("\n").map((text) => ({ sign: "+" as const, text }));
  return [];
}

/** 与 host `renderDiff` 同语义的最小 LCS（edit 无 preview 时的本地回退） */
function lcsDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const rows = oldLines.length;
  const cols = newLines.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => Array.from({ length: cols + 1 }, () => 0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i]![j]! =
        oldLines[i] === newLines[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      out.push({ sign: " ", text: oldLines[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push({ sign: "-", text: oldLines[i]! });
      i++;
    } else {
      out.push({ sign: "+", text: newLines[j]! });
      j++;
    }
  }
  while (i < rows) out.push({ sign: "-", text: oldLines[i++]! });
  while (j < cols) out.push({ sign: "+", text: newLines[j++]! });
  return out;
}

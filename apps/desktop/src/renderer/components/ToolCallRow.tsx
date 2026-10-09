import { useState } from "react";
import type { Row } from "./projection.js";
import { toolArgsPreview } from "./projection.js";

/**
 * 工具卡（M2a，§8.4h）：renderer 注册制——一种工具一个条目（zcode ToolCallBlocks 模式的
 * kcode 减法版）。折叠态一行摘要（图标+工具+参数+状态+耗时），展开态工具专属详情。
 */

interface ToolRenderer {
  icon: string;
  /** 展开态详情（输出折叠 + 工具专属区） */
  detail?: (args: unknown) => React.ReactNode;
}

const REGISTRY: Record<string, ToolRenderer> = {
  bash: { icon: "$", detail: (a) => <code className="tool-code">{str(a, "command")}</code> },
  read: { icon: "◧", detail: (a) => <code className="tool-code">{str(a, "path")}</code> },
  write: { icon: "✎", detail: (a) => <WriteDetail args={a} /> },
  edit: { icon: "✂", detail: (a) => <EditDetail args={a} /> },
  grep: { icon: "⌕", detail: (a) => <code className="tool-code">{str(a, "pattern")}</code> },
  glob: { icon: "❑", detail: (a) => <code className="tool-code">{str(a, "pattern")}</code> },
  web_search: { icon: "⌕", detail: (a) => <code className="tool-code">{str(a, "query")}</code> },
  web_fetch: { icon: "→", detail: (a) => <code className="tool-code">{str(a, "url")}</code> },
  todo: { icon: "☑" },
  ask_user: { icon: "?" },
  skill: { icon: "✦" },
  extract: { icon: "▤", detail: (a) => <code className="tool-code">{str(a, "path")}</code> },
  task: { icon: "⑃" },
};
const FALLBACK: ToolRenderer = { icon: "▪" };

function str(args: unknown, key: string): string {
  const v = (args as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : "";
}

/** write：整文件写入——展示目标与行数（diff 专属面板 M3） */
function WriteDetail({ args }: { args: unknown }): React.ReactNode {
  const content = str(args, "content");
  return (
    <div className="tool-detail">
      <code className="tool-code">{str(args, "path")}</code>
      <div className="tool-meta">写入 {content === "" ? 0 : content.split("\n").length} 行</div>
    </div>
  );
}

/** edit：轻量 inline diff（old/new 合成 +/- 行；Shiki 异步高亮 M3） */
function EditDetail({ args }: { args: unknown }): React.ReactNode {
  const oldText = str(args, "oldString");
  const newText = str(args, "newString");
  return (
    <div className="tool-detail">
      <code className="tool-code">{str(args, "path")}</code>
      <pre className="tool-diff">
        {oldText.split("\n").map((l, i) => (
          <div key={`o${i}`} className="diff-line diff-removed">-{l}</div>
        ))}
        {newText.split("\n").map((l, i) => (
          <div key={`n${i}`} className="diff-line diff-added">+{l}</div>
        ))}
      </pre>
    </div>
  );
}

export function ToolCallRowView({ row }: { row: Extract<Row, { kind: "tool" }> }) {
  const [expanded, setExpanded] = useState(false);
  const renderer = REGISTRY[row.tool] ?? FALLBACK;
  const status = row.status === "done" ? "✓" : row.status === "failed" ? "✗" : "⋯";
  const statusClass = row.status === "done" ? "tool-ok" : row.status === "failed" ? "tool-fail" : "tool-run";
  const duration = row.durationMs !== undefined ? ` ${(row.durationMs / 1000).toFixed(1)}s` : "";
  const hasBody = row.output !== undefined || row.error !== undefined || renderer.detail !== undefined;
  return (
    <div className="tool-card" data-status={row.status}>
      <button
        type="button"
        className="tool-head"
        onClick={() => hasBody && setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="tool-icon">{renderer.icon}</span>
        <span className="tool-name">{row.tool}</span>
        <span className="tool-args">{toolArgsPreview(row.tool, row.args)}</span>
        <span className={`tool-status ${statusClass}`}>
          {status}
          {duration}
        </span>
        {hasBody ? <span className="tool-chevron">{expanded ? "▾" : "▸"}</span> : null}
      </button>
      {expanded ? (
        <div className="tool-body">
          {renderer.detail?.(row.args)}
          {row.error !== undefined && row.error !== "" ? <div className="tool-error">{row.error}</div> : null}
          {row.output !== undefined && row.output !== "" ? (
            <pre className="tool-output">{row.output.slice(0, 4000)}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

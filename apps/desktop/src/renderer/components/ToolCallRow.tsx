import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  CircleHelp,
  FileSpreadsheet,
  FileText,
  FolderSearch,
  Globe,
  ListTodo,
  PenLine,
  FilePlus2,
  Search,
  Sparkles,
  SquareTerminal,
  Maximize2,
  Workflow,
  Wrench,
} from "lucide-react";
import type { Row } from "./projection.js";
import { toolArgsPreview } from "./projection.js";

/**
 * 工具卡（M2a，§8.4h）：renderer 注册制——一种工具一个条目（zcode ToolCallBlocks 模式的
 * kcode 减法版）。折叠态一行摘要（图标+工具+参数+状态+耗时），展开态工具专属详情。
 */

interface ToolRenderer {
  icon: LucideIcon;
  /** 展开态详情（输出折叠 + 工具专属区） */
  detail?: (args: unknown) => React.ReactNode;
}

const REGISTRY: Record<string, ToolRenderer> = {
  bash: { icon: SquareTerminal, detail: (a) => <code className="tool-code">{str(a, "command")}</code> },
  read: { icon: FileText, detail: (a) => <code className="tool-code">{str(a, "path")}</code> },
  write: { icon: FilePlus2, detail: (a) => <WriteDetail args={a} /> },
  edit: { icon: PenLine, detail: (a) => <EditDetail args={a} /> },
  grep: { icon: Search, detail: (a) => <code className="tool-code">{str(a, "pattern")}</code> },
  glob: { icon: FolderSearch, detail: (a) => <code className="tool-code">{str(a, "pattern")}</code> },
  web_search: { icon: Search, detail: (a) => <code className="tool-code">{str(a, "query")}</code> },
  web_fetch: { icon: Globe, detail: (a) => <code className="tool-code">{str(a, "url")}</code> },
  todo: { icon: ListTodo },
  ask_user: { icon: CircleHelp },
  skill: { icon: Sparkles },
  extract: { icon: FileSpreadsheet, detail: (a) => <code className="tool-code">{str(a, "path")}</code> },
  task: { icon: Workflow },
};
const FALLBACK: ToolRenderer = { icon: Wrench };

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

function DiffCard({
  row,
  preview,
  onOpenDiff,
}: {
  row: Extract<Row, { kind: "tool" }>;
  preview: { path?: string; diff: string };
  onOpenDiff?: (row: Extract<Row, { kind: "tool" }>) => void;
}) {
  const path = preview.path ?? (str(row.args, "path") || "(未知文件)");
  const added = preview.diff.split("\n").filter((line) => line.startsWith("+")).length;
  const removed = preview.diff.split("\n").filter((line) => line.startsWith("-")).length;
  const name = path.split(/[\\/]/).at(-1) ?? path;
  const ext = name.includes(".") ? name.split(".").at(-1)?.toUpperCase() ?? "FILE" : "FILE";
  return (
    <div className="diff-card">
      <span className="diff-card-icon">{ext.slice(0, 3)}</span>
      <div className="diff-card-copy">
        <strong>{name}</strong>
        <span>{path}</span>
      </div>
      <span className="diff-card-stat">
        <span className="stat-add">+{added}</span>
        <span className="stat-del">-{removed}</span>
      </span>
      {onOpenDiff !== undefined ? (
        <button type="button" className="diff-card-open" onClick={() => onOpenDiff(row)}>
          查看 <Maximize2 size={11} strokeWidth={1.8} />
        </button>
      ) : null}
    </div>
  );
}

export function ToolCallRowView({
  row,
  onOpenDiff,
}: {
  row: Extract<Row, { kind: "tool" }>;
  /** edit/write 在 Side Pane 打开完整 diff（M3b） */
  onOpenDiff?: (row: Extract<Row, { kind: "tool" }>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (row.preview !== undefined && (row.tool === "edit" || row.tool === "write")) {
    return <DiffCard row={row} preview={row.preview} onOpenDiff={onOpenDiff} />;
  }
  const renderer = REGISTRY[row.tool] ?? FALLBACK;
  const status = row.status === "done" ? "✓ 通过" : row.status === "failed" ? "✕ 失败" : "⋯ 运行中";
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
        <renderer.icon className="tool-icon" size={14} strokeWidth={1.75} />
        <span className="tool-name">{row.tool}</span>
        <span className="tool-args">{toolArgsPreview(row.tool, row.args)}</span>
        <span className={`tool-status ${statusClass}`}>
          {status}
          {duration}
        </span>
        {onOpenDiff !== undefined && (row.tool === "edit" || row.tool === "write") ? (
          <span
            className="tool-open-pane"
            title="在侧面板查看 diff"
            onClick={(e) => {
              e.stopPropagation();
              onOpenDiff(row);
            }}
          >
            <Maximize2 size={12} strokeWidth={1.75} />
          </span>
        ) : null}
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

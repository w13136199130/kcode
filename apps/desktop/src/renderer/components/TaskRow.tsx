import { CircleStop, Copy, Download, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { MouseEvent } from "react";

/**
 * 单行任务：标题 + 时间 + 悬浮菜单。
 * 由 DesktopSidebar 复用，菜单动作仍通过现有 host RPC。
 */
export function TaskRow(props: {
  sessionId: string;
  title: string;
  age: string;
  active: boolean;
  menu: boolean;
  editing: boolean;
  draftTitle: string;
  onOpen(): void;
  onMenu(event: MouseEvent): void;
  onDraft(value: string): void;
  onSave(): void;
  onCancel(): void;
  onRename(): void;
  onDelete(): void;
  onArchive(): void;
  onExport(): void;
  onCopyId(): void;
  onRestore?: () => void;
  canDelete: boolean;
  canArchive: boolean;
  archived: boolean;
  deleted?: boolean;
  /** S3-3：后台运行中（独立 host 存活）——橙色状态点 + 停止动作 */
  running?: boolean;
  onStopBackground?: () => void;
}) {
  return (
    <div
      className={`d2-task ${props.active ? "active" : ""}`}
      data-session-id={props.sessionId}
      role="button"
      tabIndex={0}
      onClick={props.onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onOpen();
        }
      }}
    >
      {props.editing ? (
        <input
          className="d2-rename"
          autoFocus
          value={props.draftTitle}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => props.onDraft(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") props.onSave();
            if (event.key === "Escape") props.onCancel();
          }}
          onBlur={props.onCancel}
        />
      ) : (
        <span className="d2-task-title">
          {props.running === true ? <span className="d2-running-dot" title="后台运行中" /> : null}
          {props.title}
        </span>
      )}
      <span className="d2-task-age">{props.age}</span>
      <button type="button" className="d2-task-more" title="任务操作" onClick={props.onMenu}>
        <MoreHorizontal size={13} strokeWidth={1.8} />
      </button>
      {props.menu ? (
        <div className="d2-menu d2-task-menu" onClick={(event) => event.stopPropagation()}>
          {props.deleted === true ? (
            <button type="button" onClick={props.onRestore}>
              恢复任务
            </button>
          ) : (
            <>
              <button type="button" onClick={props.onRename}>
                <Pencil size={12} strokeWidth={1.8} />
                重命名
              </button>
              <button type="button" onClick={props.onExport}>
                <Download size={12} strokeWidth={1.8} />
                导出 JSONL
              </button>
              <button type="button" onClick={props.onCopyId}>
                <Copy size={12} strokeWidth={1.8} />
                复制 ID
              </button>
              {props.running === true && props.onStopBackground !== undefined ? (
                <button type="button" className="danger" onClick={props.onStopBackground}>
                  <CircleStop size={12} strokeWidth={1.8} />
                  停止后台
                </button>
              ) : null}
              {props.canArchive ? (
                <button type="button" onClick={props.onArchive}>
                  {props.archived ? "取消归档" : "归档任务"}
                </button>
              ) : null}
              {props.canDelete ? (
                <button type="button" className="danger" onClick={props.onDelete}>
                  <Trash2 size={12} strokeWidth={1.8} />
                  删除任务
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

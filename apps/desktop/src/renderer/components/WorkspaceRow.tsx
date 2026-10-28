import { ExternalLink, Folder, MoreHorizontal, Plus, Archive, ArchiveRestore } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import type { Workspace } from "./desktop-sidebar-model.js";

/** 工作区行 + hover 操作 + 菜单；任务列表通过 children 传入。 */
export function WorkspaceRow(props: {
  workspace: Workspace;
  active: boolean;
  expanded: boolean;
  trusted: boolean;
  menuOpen: boolean;
  current: boolean;
  onOpen(): void;
  onNew(): void;
  onMenu(event: MouseEvent): void;
  onTrust(): void;
  onRemove(): void;
  onCopy(): void;
  onOpenEditor(): void;
  onArchive(): void;
  /** S3-3：新建后台任务（独立无头 host） */
  onNewBackground(): void;
  /** ZCode 式任务计数徽标（0/未传不渲染） */
  count?: number;
  children?: ReactNode;
}) {
  return (
    <div className="d2-project">
      <div
        className={`d2-project-row ${props.active ? "active" : ""}`}
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
        <Folder size={14} strokeWidth={1.7} className="d2-folder" />
        <span className="d2-project-name">{props.workspace.name}</span>
        {props.count !== undefined && props.count > 0 ? (
          <span className="d2-project-count">{props.count > 99 ? "99+" : props.count}</span>
        ) : null}
        <div className="d2-project-actions">
          <button
            type="button"
            title="新建任务"
            onClick={(event) => {
              event.stopPropagation();
              props.onNew();
            }}
          >
            <Plus size={13} strokeWidth={1.8} />
          </button>
          <button type="button" title="工作区操作" onClick={props.onMenu}>
            <MoreHorizontal size={14} strokeWidth={1.8} />
          </button>
        </div>
      </div>
      {props.menuOpen ? (
        <div className="d2-menu d2-project-menu">
          {!props.trusted ? (
            <button type="button" onClick={props.onTrust}>
              信任工作区
            </button>
          ) : null}
          <button type="button" onClick={props.onNew}>
            新建任务
          </button>
          <button type="button" onClick={props.onNewBackground}>
            新建后台任务…
          </button>
          <button type="button" onClick={props.onCopy}>
            复制工作区路径
          </button>
          <button type="button" onClick={props.onOpenEditor}>
            <ExternalLink size={12} strokeWidth={1.8} />
            在编辑器中打开
          </button>
          {!props.current ? (
            props.workspace.archived === true ? (
              <button type="button" onClick={props.onArchive}>
                <ArchiveRestore size={12} strokeWidth={1.8} />
                取消归档工作区
              </button>
            ) : (
              <button type="button" onClick={props.onArchive}>
                <Archive size={12} strokeWidth={1.8} />
                归档工作区
              </button>
            )
          ) : null}
          {!props.current ? (
            <button type="button" className="danger" onClick={props.onRemove}>
              从列表移除
            </button>
          ) : null}
        </div>
      ) : null}
      {props.expanded ? props.children : null}
    </div>
  );
}

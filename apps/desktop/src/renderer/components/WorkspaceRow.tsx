import { Folder, MoreHorizontal, Plus } from "lucide-react";
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
          <button type="button" onClick={props.onCopy}>
            复制工作区路径
          </button>
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

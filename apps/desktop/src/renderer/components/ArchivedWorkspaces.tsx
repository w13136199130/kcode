import { ArchiveRestore, ChevronDown, Folder } from "lucide-react";
import type { Workspace } from "./desktop-sidebar-model.js";

/** S1-1（F5）：已归档工作区分区——只列名称/任务数/取消归档，任务仍在索引中不受影响。 */
export function ArchivedWorkspaces({
  workspaces,
  open,
  onToggle,
  onRestore,
}: {
  workspaces: Workspace[];
  open: boolean;
  onToggle(): void;
  onRestore(workspace: Workspace): void;
}) {
  if (workspaces.length === 0) return null;
  return (
    <section className="d2-section d2-archived-workspaces">
      <div className="d2-section-head">
        <button type="button" className="d2-label" onClick={onToggle}>
          <span>已归档工作区（{workspaces.length}）</span>
          <ChevronDown size={12} strokeWidth={2} className={open ? "" : "d2-chevron-closed"} />
        </button>
      </div>
      {open ? (
        <div className="d2-archived-workspace-list">
          {workspaces.map((workspace) => (
            <div key={workspace.key} className="d2-archived-workspace" data-workspace-key={workspace.key}>
              <Folder size={13} strokeWidth={1.7} className="d2-folder" />
              <span className="d2-archived-workspace-name">{workspace.name}</span>
              <span className="d2-archived-workspace-count">{workspace.sessions.length} 任务</span>
              <button
                type="button"
                className="d2-archived-workspace-restore"
                title="取消归档工作区"
                onClick={() => onRestore(workspace)}
              >
                <ArchiveRestore size={12} strokeWidth={1.8} />
                取消归档
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

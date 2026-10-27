import { ChevronDown } from "lucide-react";
import type { MouseEvent } from "react";
import type { SessionSummary } from "./desktop-sidebar-model.js";
import { relativeTime, sessionTitle } from "./desktop-sidebar-model.js";
import { TaskRow } from "./TaskRow.js";

/** 回收站：软删除的会话，可恢复。 */
export function TrashTaskList(props: {
  sessions: SessionSummary[];
  open: boolean;
  onToggle(): void;
  currentId: string | null;
  menuKey: string | null;
  onOpen(session: SessionSummary): void;
  onMenu(session: SessionSummary, event: MouseEvent): void;
  onRestore(session: SessionSummary): void;
  onEmpty(): void;
}) {
  return (
    <section className="d2-section d2-trash">
      <div className="d2-section-head">
        <button type="button" className="d2-label" onClick={props.onToggle}>
          <span>回收站</span>
          <ChevronDown size={12} strokeWidth={2} className={props.open ? "" : "d2-chevron-closed"} />
        </button>
        <button type="button" className="d2-trash-empty" onClick={props.onEmpty}>
          清空
        </button>
      </div>
      {props.open ? (
        <div className="d2-inbox-list">
          {props.sessions.map((session) => (
            <TaskRow
              key={session.sessionId}
              sessionId={session.sessionId}
              title={sessionTitle(session, props.currentId)}
              age={relativeTime(session.modifiedAt)}
              active={false}
              menu={props.menuKey === session.sessionId}
              editing={false}
              draftTitle=""
              onOpen={() => props.onOpen(session)}
              onMenu={(event) => props.onMenu(session, event)}
              onDraft={() => undefined}
              onSave={() => undefined}
              onCancel={() => undefined}
              onRename={() => undefined}
              onDelete={() => undefined}
              onArchive={() => undefined}
              onExport={() => undefined}
              onCopyId={() => undefined}
              onRestore={() => props.onRestore(session)}
              canDelete={false}
              canArchive={false}
              archived={false}
              deleted={true}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

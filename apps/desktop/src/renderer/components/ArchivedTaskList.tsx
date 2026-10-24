import { ChevronDown } from "lucide-react";
import type { MouseEvent } from "react";
import type { SessionSummary } from "./desktop-sidebar-model.js";
import { relativeTime, sessionTitle } from "./desktop-sidebar-model.js";
import { TaskRow } from "./TaskRow.js";

/** “已归档”任务列表；动作与普通任务共用 host RPC。 */
export function ArchivedTaskList(props: {
  sessions: SessionSummary[];
  open: boolean;
  onToggle(): void;
  currentId: string | null;
  menuKey: string | null;
  editingId: string | null;
  draftTitle: string;
  onOpen(session: SessionSummary): void;
  onMenu(session: SessionSummary, event: MouseEvent): void;
  onDraft(value: string): void;
  onSave(sessionId: string): void;
  onCancel(): void;
  onRename(session: SessionSummary): void;
  onDelete(session: SessionSummary): void;
  onArchive(session: SessionSummary): void;
}) {
  return (
    <section className="d2-section d2-archived">
      <div className="d2-section-head">
        <button type="button" className="d2-label" onClick={props.onToggle}>
          <span>已归档</span>
          <ChevronDown size={12} strokeWidth={2} className={props.open ? "" : "d2-chevron-closed"} />
        </button>
      </div>
      {props.open ? (
        <div className="d2-inbox-list">
          {props.sessions.map((session) => (
            <TaskRow
              key={session.sessionId}
              title={sessionTitle(session, props.currentId)}
              age={relativeTime(session.modifiedAt)}
              active={session.sessionId === props.currentId}
              menu={props.menuKey === session.sessionId}
              editing={props.editingId === session.sessionId}
              draftTitle={props.draftTitle}
              onOpen={() => props.onOpen(session)}
              onMenu={(event) => props.onMenu(session, event)}
              onDraft={props.onDraft}
              onSave={() => props.onSave(session.sessionId)}
              onCancel={props.onCancel}
              onRename={() => props.onRename(session)}
              onDelete={() => props.onDelete(session)}
              onArchive={() => props.onArchive(session)}
              canDelete={session.sessionId !== props.currentId}
              canArchive={true}
              archived={true}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}


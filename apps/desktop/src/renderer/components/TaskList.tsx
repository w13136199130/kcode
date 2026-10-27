import type { MouseEvent } from "react";
import type { SessionSummary } from "./desktop-sidebar-model.js";
import { relativeTime, sessionTitle } from "./desktop-sidebar-model.js";
import { TaskRow } from "./TaskRow.js";

/** 普通任务列表（工作区/未归类共用）。 */
export function TaskList(props: {
  sessions: SessionSummary[];
  currentId: string | null;
  menuKey: string | null;
  editingId: string | null;
  draftTitle: string;
  emptyText: string;
  archived: boolean;
  onOpen(session: SessionSummary): void;
  onMenu(session: SessionSummary, event: MouseEvent): void;
  onDraft(value: string): void;
  onSave(sessionId: string): void;
  onCancel(): void;
  onRename(session: SessionSummary): void;
  onDelete(session: SessionSummary): void;
  onArchive(session: SessionSummary, archived: boolean): void;
}) {
  return (
    <div className="d2-tasks">
      {props.sessions.length === 0 ? (
        <div className="d2-empty">{props.emptyText}</div>
      ) : (
        props.sessions.map((session) => (
          <TaskRow
            key={session.sessionId}
            sessionId={session.sessionId}
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
            onArchive={() => props.onArchive(session, !props.archived)}
            canDelete={session.sessionId !== props.currentId}
            canArchive={props.archived || session.sessionId !== props.currentId}
            archived={props.archived}
          />
        ))
      )}
    </div>
  );
}

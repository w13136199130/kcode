import type { Dispatch, SetStateAction } from "react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";
import type { SessionSummary } from "../components/desktop-sidebar-model.js";

/**
 * S1：侧栏任务动作（重命名/删除/恢复/清空回收站/归档/导出/复制 ID）——
 * 从 DesktopSidebar 原样搬出（max-lines 收口）；失败可见不静默。
 */
export function useSidebarTaskActions(opts: {
  conn: HostConnection;
  currentId: string | null;
  draftTitle: string;
  setNotice(value: string): void;
  setMenu(menu: { kind: "workspace" | "task"; key: string } | null): void;
  setEditingId(id: string | null): void;
  setDraftTitle(value: string): void;
  refreshSessions(): void;
}): {
  startRename(session: SessionSummary): void;
  saveTitle(sessionId: string): Promise<void>;
  removeSession(session: SessionSummary): Promise<void>;
  restoreSession(session: SessionSummary): Promise<void>;
  emptyTrash(): Promise<void>;
  archiveSession(session: SessionSummary, archived: boolean): Promise<void>;
  copySessionId(session: SessionSummary): Promise<void>;
  exportSession(session: SessionSummary): Promise<void>;
} {
  const { conn, currentId, draftTitle } = opts;
  const startRename = (session: SessionSummary): void => {
    opts.setEditingId(session.sessionId);
    opts.setDraftTitle(session.title ?? session.preview);
    opts.setMenu(null);
  };
  const saveTitle = async (sessionId: string): Promise<void> => {
    const title = draftTitle.trim();
    if (title === "") {
      opts.setEditingId(null);
      return;
    }
    try {
      await conn.send("sessions/rename", { sessionId, title });
      opts.setEditingId(null);
      opts.refreshSessions();
    } catch {
      // 保持编辑态，让用户重试。
    }
  };
  const removeSession = async (session: SessionSummary): Promise<void> => {
    if (session.sessionId === currentId) {
      window.alert("不能删除正在使用的会话，先切换到其他任务或新建任务。");
      return;
    }
    if (!window.confirm("把这个任务移到回收站？之后可以恢复。")) return;
    try {
      await conn.send("sessions/delete", { sessionId: session.sessionId });
      opts.setMenu(null);
      opts.refreshSessions();
    } catch {
      // host 拒绝时保留现状，不做静默删除。
    }
  };
  const restoreSession = async (session: SessionSummary): Promise<void> => {
    try {
      await conn.send("sessions/restore", { sessionId: session.sessionId });
      opts.setMenu(null);
      opts.refreshSessions();
    } catch (error) {
      window.alert(`恢复失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const emptyTrash = async (): Promise<void> => {
    if (!window.confirm("永久清空回收站？会话文件将被删除，无法恢复。")) return;
    try {
      await conn.send("sessions/empty_trash");
      opts.refreshSessions();
    } catch (error) {
      window.alert(`清空回收站失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const archiveSession = async (session: SessionSummary, archived: boolean): Promise<void> => {
    try {
      await conn.send("sessions/archive", { sessionId: session.sessionId, archived });
      opts.setMenu(null);
      opts.refreshSessions();
    } catch (error) {
      window.alert(`归档失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // S1-1（F4）：复制会话 ID
  const copySessionId = async (session: SessionSummary): Promise<void> => {
    opts.setMenu(null);
    try {
      await navigator.clipboard.writeText(session.sessionId);
      opts.setNotice(`已复制会话 ID：${session.sessionId.slice(0, 16)}…`);
    } catch {
      opts.setNotice("复制失败：剪贴板不可用");
    }
  };
  // S1-1（F4）：导出会话 JSONL（目录选择走既有 pickDirectory；host 落盘，不新增 IPC）
  const exportSession = async (session: SessionSummary): Promise<void> => {
    opts.setMenu(null);
    const dir = await window.kcodeHost?.pickDirectory();
    if (dir === null || dir === undefined || dir === "") return;
    try {
      const result = (await conn.send("session/export", {
        sessionId: session.sessionId,
        targetDir: dir,
      })) as { path?: string };
      window.alert(`已导出：${result.path ?? dir}`);
    } catch (error) {
      window.alert(`导出失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return { startRename, saveTitle, removeSession, restoreSession, emptyTrash, archiveSession, copySessionId, exportSession };
}

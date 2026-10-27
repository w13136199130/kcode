import type { SessionSummary } from "../components/desktop-sidebar-model.js";
import type { LocalSession } from "./session-workspaces.js";

/**
 * P3-2：host 索引优先，localStorage 只补缺。
 * - host 已有 workspaceKey：绝不被本地冲突覆盖；
 * - host 缺归属/摘要：允许本地补缺（旧会话/索引尚未落盘）；
 * - host 完全缺失：仅保留当前草稿或有 preview 的本地条目，作为离线兜底。
 */
export function mergeSessionSources(
  hostSessions: SessionSummary[],
  localSessions: LocalSession[],
  current: { id: string | null; workspace: string; preview: string; ungrouped?: boolean },
): SessionSummary[] {
  const localById = new Map(localSessions.map((item) => [item.sessionId, item]));
  const merged = hostSessions.map((session) => {
    const local = localById.get(session.sessionId);
    const hostKey = (session.workspaceKey ?? "").trim();
    const hostPreview = session.preview.trim();
    const workspaceKey = hostKey !== "" ? hostKey : (local?.cwd ?? "");
    const preview =
      hostPreview !== ""
        ? session.preview
        : session.sessionId === current.id && current.preview.trim() !== ""
          ? current.preview
          : (local?.preview ?? "");
    return {
      ...session,
      workspaceKey,
      preview,
      turns: Math.max(session.turns, preview === "" ? 0 : 1),
    };
  });

  const known = new Set(merged.map((session) => session.sessionId));
  const missing = localSessions
    .filter(
      (local) =>
        !known.has(local.sessionId) &&
        (local.preview !== undefined || local.sessionId === current.id),
    )
    .map((local) => ({
      sessionId: local.sessionId,
      preview: local.preview ?? (local.sessionId === current.id ? current.preview : ""),
      turns: local.preview !== undefined ? 1 : 0,
      modifiedAt: local.createdAt,
      workspaceKey: local.cwd,
    }));

  if (current.id === null || known.has(current.id) || missing.some((s) => s.sessionId === current.id)) {
    return missing.length > 0 ? [...missing, ...merged] : merged;
  }
  return [
    {
      sessionId: current.id,
      preview: current.preview,
      turns: current.preview === "" ? 0 : 1,
      modifiedAt: Date.now(),
      workspaceKey: current.workspace,
      ...(current.ungrouped === true ? { ungrouped: true } : {}),
    },
    ...missing,
    ...merged,
  ];
}

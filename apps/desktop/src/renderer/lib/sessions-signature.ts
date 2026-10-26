import type { SessionSummary } from "../components/desktop-sidebar-model.js";

/**
 * 会话列表内容签名（P1-2 / M5）：轮询或信号重拉结果未变化时跳过 setState，
 * 侧栏整树不再无意义重渲染。字段覆盖分组/标题/状态位——任何一个变化都应刷新。
 */
export function sessionsSignature(sessions: SessionSummary[]): string {
  return sessions
    .map((session) =>
      [
        session.sessionId,
        session.modifiedAt ?? "",
        session.workspaceKey ?? "",
        session.title ?? "",
        session.turns,
        session.preview,
        session.draft === true ? "d" : "",
        session.archived === true ? "a" : "",
        session.deleted === true ? "x" : "",
      ].join("|"),
    )
    .join(";");
}

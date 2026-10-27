import { useCallback, useRef } from "react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";
import { rememberSessionWorkspace } from "../lib/session-workspaces.js";
import { describeCreateError, switchBlockedReason, type CreateFailure } from "../lib/switch-guards.js";

/**
 * 桌面会话切换（Slice 1）：同窗口 dispose → create，支持指定工作区。
 * 从 main.tsx 抽出，避免单文件继续膨胀。
 *
 * P0-2/P0-3：失败不再静默——上抛 onFailure 驱动主区失败卡片（重试/恢复上一任务）；
 * 运行中（busy）新建/切换只提示不 dispose，防止静默中止正在执行的任务。
 */
export function useDesktopSessionSwitching(options: {
  conn: HostConnection;
  modelDefault: string | null;
  defaultCwd: string;
  sessionId: string | null;
  busy: boolean;
  /** 时间线追加一条警告行（busy 拦截等提示） */
  notify(text: string): void;
  /** 创建/续接失败：由 main.tsx 渲染失败卡片 */
  onFailure(failure: CreateFailure): void;
  setDefaultCwd(value: string): void;
  setSessionId(value: string | null): void;
  setSessionVersion(update: (value: number) => number): void;
  setQueuedCount(value: number): void;
  resetTimeline(): void;
}): {
  onNewSession(workspacePath?: string, opts?: { requestId?: string; ungrouped?: boolean }): void;
  onResume(sessionId: string, workspacePath?: string): void;
} {
  const {
    conn,
    modelDefault,
    defaultCwd,
    sessionId,
    busy,
    notify,
    onFailure,
    setDefaultCwd,
    setSessionId,
    setSessionVersion,
    setQueuedCount,
    resetTimeline,
  } = options;
  const switchToken = useRef(0);

  const onNewSession = useCallback(
    (workspacePath?: string, opts?: { requestId?: string; ungrouped?: boolean }): void => {
      const cwd = workspacePath ?? defaultCwd;
      if (modelDefault === null || cwd === "") return;
      if (busy) {
        notify(switchBlockedReason("new"));
        return;
      }
      const token = ++switchToken.current;
      const previousSessionId = sessionId;
      const requestId =
        opts?.requestId ?? globalThis.crypto?.randomUUID?.() ?? `create_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      resetTimeline();
      // 旧 host 会话已 dispose；新 create 返回前关闭“可发送”，避免消息写到旧会话。
      setSessionId(null);
      setQueuedCount(0);
      void conn
        .send("session/dispose")
        .then(() => conn.send("session/create", { model: modelDefault, cwd, requestId, ...(opts?.ungrouped === true ? { ungrouped: true } : {}) }))
        .then((result) => {
          const id = (result as { sessionId: string }).sessionId;
          rememberSessionWorkspace(id, cwd);
          if (token !== switchToken.current) return;
          if (cwd !== defaultCwd) {
            localStorage.setItem("kcode-last-cwd", cwd);
            setDefaultCwd(cwd);
          }
          setSessionId(id);
          setSessionVersion((value) => value + 1);
        })
        .catch((err) => {
          // 已有更新的切换在途：旧请求的失败不覆盖新状态
          if (token !== switchToken.current) return;
          onFailure({ cwd, requestId, previousSessionId, error: describeCreateError(err) });
        });
    },
    [
      conn,
      modelDefault,
      defaultCwd,
      sessionId,
      busy,
      notify,
      onFailure,
      setDefaultCwd,
      setQueuedCount,
      setSessionId,
      setSessionVersion,
      resetTimeline,
    ],
  );

  const onResume = useCallback(
    (id: string, workspacePath?: string): void => {
      const cwd = workspacePath ?? defaultCwd;
      if (modelDefault === null || cwd === "" || (id === sessionId && cwd === defaultCwd)) return;
      if (busy) {
        notify(switchBlockedReason("switch"));
        return;
      }
      const token = ++switchToken.current;
      const previousSessionId = sessionId;
      resetTimeline();
      // 旧 host 会话已 dispose；新 create 返回前关闭“可发送”，避免消息写到旧会话。
      setSessionId(null);
      setQueuedCount(0);
      void conn
        .send("session/dispose")
        .then(() => conn.send("session/create", { model: modelDefault, cwd, resumeFrom: id }))
        .then(() => {
          if (token !== switchToken.current) return;
          if (cwd !== defaultCwd) {
            localStorage.setItem("kcode-last-cwd", cwd);
            setDefaultCwd(cwd);
          }
          setSessionId(id);
          setSessionVersion((value) => value + 1);
        })
        .catch((err) => {
          if (token !== switchToken.current) return;
          onFailure({ cwd, previousSessionId, resumeFrom: id, error: describeCreateError(err) });
        });
    },
    [
      conn,
      modelDefault,
      defaultCwd,
      sessionId,
      busy,
      notify,
      onFailure,
      setDefaultCwd,
      setQueuedCount,
      setSessionId,
      setSessionVersion,
      resetTimeline,
    ],
  );

  return { onNewSession, onResume };
}

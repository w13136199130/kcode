import { useCallback, useRef } from "react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";
import { rememberSessionWorkspace } from "../lib/session-workspaces.js";

/**
 * 桌面会话切换（Slice 1）：同窗口 dispose → create，支持指定工作区。
 * 从 main.tsx 抽出，避免单文件继续膨胀。
 */
export function useDesktopSessionSwitching(options: {
  conn: HostConnection;
  modelDefault: string | null;
  defaultCwd: string;
  sessionId: string | null;
  setDefaultCwd(value: string): void;
  setSessionId(value: string | null): void;
  setSessionVersion(update: (value: number) => number): void;
  setQueuedCount(value: number): void;
  resetTimeline(): void;
}): {
  onNewSession(workspacePath?: string): void;
  onResume(sessionId: string, workspacePath?: string): void;
} {
  const {
    conn,
    modelDefault,
    defaultCwd,
    sessionId,
    setDefaultCwd,
    setSessionId,
    setSessionVersion,
    setQueuedCount,
    resetTimeline,
  } = options;
  const switchToken = useRef(0);

  const onNewSession = useCallback(
    (workspacePath?: string): void => {
      const cwd = workspacePath ?? defaultCwd;
      if (modelDefault === null || cwd === "") return;
      const token = ++switchToken.current;
      resetTimeline();
      // 旧 host 会话已 dispose；新 create 返回前关闭“可发送”，避免消息写到旧会话。
      setSessionId(null);
      setQueuedCount(0);
      void conn
        .send("session/dispose")
        .then(() => conn.send("session/create", { model: modelDefault, cwd }))
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
        .catch(() => undefined);
    },
    [conn, modelDefault, defaultCwd, setDefaultCwd, setQueuedCount, setSessionId, setSessionVersion, resetTimeline],
  );

  const onResume = useCallback(
    (id: string, workspacePath?: string): void => {
      const cwd = workspacePath ?? defaultCwd;
      if (modelDefault === null || cwd === "" || (id === sessionId && cwd === defaultCwd)) return;
      const token = ++switchToken.current;
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
        .catch(() => undefined);
    },
    [conn, modelDefault, defaultCwd, sessionId, setDefaultCwd, setQueuedCount, setSessionId, setSessionVersion, resetTimeline],
  );

  return { onNewSession, onResume };
}

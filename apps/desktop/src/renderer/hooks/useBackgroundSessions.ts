import { useCallback, useEffect, useState } from "react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";

/**
 * S3-3 多会话并行（renderer 侧）：后台会话状态轮询 + start/stop。
 * 数据来自 host BackgroundManager（background/list/start/stop RPC）；
 * 后台会话的事件已由 S2-1 分片按 sessionId 路由，无需 renderer 额外处理。
 */
export interface BackgroundSession {
  sessionId: string;
  busy: boolean;
  alive: boolean;
  preview: string;
  startedAt: number;
}

export function useBackgroundSessions(conn: HostConnection): {
  sessions: BackgroundSession[];
  /** 运行中（子 host 存活）的后台会话 id 集合——侧栏状态点数据源 */
  runningIds: Set<string>;
  startBackground(model: string, cwd: string, prompt: string): Promise<string | null>;
  stopBackground(sessionId: string): Promise<void>;
} {
  const [sessions, setSessions] = useState<BackgroundSession[]>([]);

  useEffect(() => {
    if (conn.status !== "ready") return;
    let cancelled = false;
    const load = (): void => {
      void conn
        .send("background/list")
        .then((r) => {
          if (!cancelled) setSessions(((r as { sessions?: BackgroundSession[] }).sessions ?? []));
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [conn]);

  const startBackground = useCallback(
    async (model: string, cwd: string, prompt: string): Promise<string | null> => {
      try {
        const r = (await conn.send("background/start", { model, cwd, prompt })) as { sessionId?: string };
        void conn.send("background/list").then((lr) => {
          setSessions(((lr as { sessions?: BackgroundSession[] }).sessions ?? []));
        }).catch(() => undefined);
        return r.sessionId ?? null;
      } catch {
        return null;
      }
    },
    [conn],
  );

  const stopBackground = useCallback(
    async (sessionId: string): Promise<void> => {
      await conn.send("background/stop", { sessionId }).catch(() => undefined);
      setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
    },
    [conn],
  );

  const runningIds = new Set(sessions.filter((s) => s.alive).map((s) => s.sessionId));
  return { sessions, runningIds, startBackground, stopBackground };
}

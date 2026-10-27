import { useEffect, useState } from "react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";

export interface ContextStats {
  contextWindow: number;
  windowKnown: boolean;
  historyTokens: number;
  historyBudget: number;
  sessionUsage?: { inputTokens?: number; outputTokens?: number; calls?: number };
}

/** 上下文容量：host 真实 contextStats 轮询（无 usage 时不伪造数字）。 */
export function useSessionContext(conn: HostConnection, sessionId: string | null, busy: boolean): ContextStats | null {
  const [stats, setStats] = useState<ContextStats | null>(null);

  useEffect(() => {
    if (sessionId === null || conn.status !== "ready") {
      setStats(null);
      return;
    }
    let cancelled = false;
    const load = (): void => {
      void conn
        .send("session/context")
        .then((result) => {
          if (!cancelled) setStats(result as ContextStats | null);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [conn.send, conn.status, sessionId, busy]);

  return stats;
}

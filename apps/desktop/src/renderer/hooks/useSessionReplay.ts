import { useEffect, type MutableRefObject } from "react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";
import type { SessionEvent } from "@kcode/contracts";
import { applyEvent, initialTimeline, type TimelineState } from "../components/projection.js";

/** 会话切换后重放全量事件；失败时追加可见警告行。 */
export function useSessionReplay(options: {
  conn: HostConnection;
  sessionId: string | null;
  sessionVersion: number;
  processed: MutableRefObject<number>;
  setTimeline(value: TimelineState | ((prev: TimelineState) => TimelineState)): void;
}): void {
  useEffect(() => {
    if (options.conn.status !== "ready" || options.sessionId === null) return;
    // S2-1：不再立即清空——切换钩子已画上目标会话的分片缓存（或空态），
    // 重放在本地全量重建后一次性替换（权威），期间用户看到的是可交互的旧画面。
    let cancelled = false;
    void options.conn
      .send("session/replay")
      .then((r) => {
        if (cancelled) return;
        const { events } = r as { sessionId: string; events: SessionEvent[] };
        let state = initialTimeline();
        for (const ev of events) state = applyEvent(state, { type: "session/event", event: ev });
        options.setTimeline(state);
        options.processed.current = options.conn.events.length;
      })
      .catch((err) => {
        if (cancelled) return;
        options.setTimeline((prev) => ({
          ...prev,
          rows: [
            ...prev.rows,
            {
              kind: "info" as const,
              text: `转写恢复失败：${err instanceof Error ? err.message : String(err)}`,
              tone: "warn" as const,
            },
          ],
        }));
      });
    return () => {
      cancelled = true;
    };
    // sessionVersion 变化（切换续接）时重放
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.conn.status, options.sessionId, options.sessionVersion]);
}

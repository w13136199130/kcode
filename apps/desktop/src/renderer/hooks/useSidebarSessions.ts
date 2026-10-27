import { useEffect, useMemo, useRef, useState } from "react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";
import type { SessionSummary } from "../components/desktop-sidebar-model.js";
import { listLocalSessions } from "../lib/session-workspaces.js";
import { mergeSessionSources } from "../lib/session-merge.js";
import { sessionsSignature } from "../lib/sessions-signature.js";

/**
 * 侧栏会话列表：轮询 + 当前会话乐观摘要。
 * P1-2（M5）：结果签名未变化不 setState（空转 30s 轮询零重渲染）；
 * activity/sessions/changed 等信号 200ms 合并防抖后重拉，连续事件只打一次 RPC。
 */
export function useSidebarSessions(options: {
  conn: HostConnection;
  currentId: string | null;
  currentWorkspace: string;
  currentPreview: string;
  activityKey: number;
  sessionsSignal: number;
  query: string;
  currentUngrouped: boolean;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const lastSignature = useRef<string | null>(null);
  const loadRef = useRef<() => void>(() => undefined);
  const queryRef = useRef(options.query);
  queryRef.current = options.query;
  const requestSeq = useRef(0);

  // 基础链路：连接就绪立即拉一次 + 30s 轮询（interval 不随信号重建）
  useEffect(() => {
    if (options.conn.status !== "ready") return;
    const send = options.conn.send;
    let cancelled = false;
    const load = (offset = 0, append = false): void => {
      const seq = ++requestSeq.current;
      void send("sessions/list", { query: queryRef.current, limit: 200, offset })
        .then((result) => {
          if (cancelled || seq !== requestSeq.current) return;
          const payload = result as {
            sessions?: SessionSummary[];
            total?: number;
            hasMore?: boolean;
          };
          const list = payload.sessions ?? [];
          setHasMore(payload.hasMore === true);
          setTotal(payload.total ?? list.length);
          if (append) {
            setSessions((prev) => {
              const seen = new Set(prev.map((session) => session.sessionId));
              return [...prev, ...list.filter((session) => !seen.has(session.sessionId))];
            });
            return;
          }
          const signature = sessionsSignature(list);
          if (signature === lastSignature.current) return;
          lastSignature.current = signature;
          setSessions(list);
        })
        .catch(() => undefined);
    };
    loadRef.current = () => load(0, false);
    load();
    const timer = window.setInterval(() => load(0, false), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [options.conn.send, options.conn.status]);

  // 搜索输入防抖；变更信号（activityKey / sessions/changed / 手动刷新）200ms 合并。
  useEffect(() => {
    if (options.conn.status !== "ready") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled) loadRef.current();
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [options.conn.status, options.activityKey, options.sessionsSignal, refreshKey]);

  const effectiveSessions = useMemo(() => {
    const merged = mergeSessionSources(sessions, listLocalSessions(), {
      id: options.currentId,
      workspace: options.currentWorkspace,
      preview: options.currentPreview.trim(),
      ungrouped: options.currentUngrouped,
    });
    const q = options.query.trim().toLocaleLowerCase();
    if (q === "") return merged;
    return merged.filter((session) => `${session.title ?? ""}\n${session.preview}`.toLocaleLowerCase().includes(q));
  }, [options.currentId, options.currentPreview, options.currentWorkspace, options.query, sessions]);

  const loadMore = (): void => {
    if (!hasMore) return;
    const seq = ++requestSeq.current;
    // loadRef 只做 page 0；分页直接复用同一 send，避免把 offset 状态塞进轮询闭包。
    void options.conn
      .send("sessions/list", { query: options.query, limit: 200, offset: sessions.length })
      .then((result) => {
        if (seq !== requestSeq.current) return;
        const payload = result as { sessions?: SessionSummary[]; hasMore?: boolean; total?: number };        const list = payload.sessions ?? [];
        setHasMore(payload.hasMore === true);
        setTotal(payload.total ?? total);
        setSessions((prev) => {
          const seen = new Set(prev.map((session) => session.sessionId));
          return [...prev, ...list.filter((session) => !seen.has(session.sessionId))];
        });
      })
      .catch(() => undefined);
  };

  return {
    effectiveSessions,
    hasMore,
    total,
    loadMore,
    refreshSessions: () => setRefreshKey((value) => value + 1),
  };
}

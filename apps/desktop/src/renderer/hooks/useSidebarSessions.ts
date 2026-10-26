import { useEffect, useMemo, useRef, useState } from "react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";
import type { SessionSummary } from "../components/desktop-sidebar-model.js";
import { listLocalSessions, rememberSessionPreview } from "../lib/session-workspaces.js";
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
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const lastSignature = useRef<string | null>(null);
  const loadRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (options.currentId !== null && options.currentPreview.trim() !== "") {
      rememberSessionPreview(options.currentId, options.currentPreview);
    }
  }, [options.currentId, options.currentPreview]);

  // 基础链路：连接就绪立即拉一次 + 30s 轮询（interval 不随信号重建）
  useEffect(() => {
    if (options.conn.status !== "ready") return;
    const send = options.conn.send;
    let cancelled = false;
    const load = (): void => {
      void send("sessions/list")
        .then((result) => {
          if (cancelled) return;
          const list = (result as { sessions?: SessionSummary[] }).sessions ?? [];
          const signature = sessionsSignature(list);
          if (signature === lastSignature.current) return;
          lastSignature.current = signature;
          setSessions(list.slice(0, 200));
        })
        .catch(() => undefined);
    };
    loadRef.current = load;
    load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [options.conn.send, options.conn.status]);

  // 变更信号（activityKey / sessions/changed / 手动刷新）：200ms 合并防抖
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
    if (options.currentId === null) return sessions;
    const preview = options.currentPreview.trim();
    const locals = listLocalSessions();
    const localById = new Map(locals.map((item) => [item.sessionId, item]));
    const merged = sessions.map((session) => {
      const local = localById.get(session.sessionId);
      if (local === undefined) return session;
      const workspaceKey = (session.workspaceKey ?? "").trim() === "" ? local.cwd : session.workspaceKey;
      const nextPreview = session.preview.trim() === "" ? (local.preview ?? "") : session.preview;
      return { ...session, workspaceKey, preview: nextPreview, turns: Math.max(session.turns, nextPreview === "" ? 0 : 1) };
    });
    const known = new Set(merged.map((session) => session.sessionId));
    const missing: SessionSummary[] = locals
      .filter((local) => !known.has(local.sessionId) && (local.preview !== undefined || local.sessionId === options.currentId))
      .map((local) => ({
        sessionId: local.sessionId,
        preview: local.preview ?? (local.sessionId === options.currentId ? preview : ""),
        turns: local.preview !== undefined ? 1 : 0,
        modifiedAt: local.createdAt,
        workspaceKey: local.cwd,
      }));
    if (missing.length === 0) return merged;

    const current = merged.find((session) => session.sessionId === options.currentId);
    if (current === undefined && !missing.some((session) => session.sessionId === options.currentId)) {
      missing.unshift({
        sessionId: options.currentId,
        preview,
        turns: preview === "" ? 0 : 1,
        modifiedAt: Date.now(),
        workspaceKey: options.currentWorkspace,
      });
    }
    return [...missing, ...merged];
  }, [options.currentId, options.currentPreview, options.currentWorkspace, sessions]);

  return { effectiveSessions, refreshSessions: () => setRefreshKey((value) => value + 1) };
}

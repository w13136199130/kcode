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
 * 手测反馈：服务端单页上限 200，旧“加载更多”与 30s 轮询互相打架（轮询把列表重置回
 * 第一页又置 hasMore=true，按钮永驻）——改为一次循环拉全量（≤5 页/1000 条），按钮删除。
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
    const load = (): void => {
      const seq = ++requestSeq.current;
      const fetchAll = async (): Promise<SessionSummary[]> => {
        const out: SessionSummary[] = [];
        const seen = new Set<string>();
        let offset = 0;
        for (let page = 0; page < 5; page += 1) {
          const r = (await send("sessions/list", { query: queryRef.current, limit: 200, offset })) as {
            sessions?: SessionSummary[];
            hasMore?: boolean;
          };
          const list = r.sessions ?? [];
          for (const session of list) {
            if (seen.has(session.sessionId)) continue;
            seen.add(session.sessionId);
            out.push(session);
          }
          if (r.hasMore !== true || list.length === 0) break;
          offset += list.length;
        }
        return out;
      };
      void fetchAll()
        .then((list) => {
          if (cancelled || seq !== requestSeq.current) return;
          const signature = sessionsSignature(list);
          if (signature === lastSignature.current) return;
          lastSignature.current = signature;
          setSessions(list);
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

  return {
    effectiveSessions,
    refreshSessions: () => setRefreshKey((value) => value + 1),
  };
}

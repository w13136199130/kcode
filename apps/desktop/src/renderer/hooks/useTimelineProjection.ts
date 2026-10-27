import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { PermissionMode } from "@kcode/contracts";
import type { HostConnection } from "@web/hooks/useHostConnection.js";
import { applyEvent, type TimelineState } from "../components/projection.js";
import { sessionOfEvent, type TimelineShards } from "../lib/timeline-shards.js";

/** 弹层状态形状（原 main.tsx 本地接口，随 S0-4 拆迁） */
export interface AskState {
  requestId: string;
  tool: string;
  args: unknown;
  preview?: { path?: string; diff: string };
}
export interface QuestionState {
  requestId: string;
  question: { question: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean };
}
export interface PlanState {
  requestId: string;
  plan: string;
}

/**
 * 事件流 → 投影与弹层（S0-4 从 main.tsx 原样拆出）：
 * 先分流弹层/队列事件（ask/plan/question/queue/mode），其余逐条 applyEvent 并入时间线。
 * processed 计数由调用方持有（useSessionReplay 重放时消费同一游标）。
 */
export function useTimelineProjection(opts: {
  conn: HostConnection;
  processed: MutableRefObject<number>;
  setQueuedCount: Dispatch<SetStateAction<number>>;
  setAsk: Dispatch<SetStateAction<AskState | null>>;
  setQuestion: Dispatch<SetStateAction<QuestionState | null>>;
  setPlan: Dispatch<SetStateAction<PlanState | null>>;
  setMode: Dispatch<SetStateAction<PermissionMode>>;
  setTimeline: Dispatch<SetStateAction<TimelineState>>;
  /** S2-1：当前会话 id 与分片表——其他会话的事件并入其缓存分片，不串当前画面 */
  currentSessionId: string | null;
  shards: TimelineShards;
}): void {
  const { conn, processed } = opts;
  useEffect(() => {
    const news = conn.events.slice(processed.current);
    processed.current = conn.events.length;
    if (news.length === 0) return;
    for (const ev of news) {
      const evSession = sessionOfEvent(ev);
      if (evSession !== null && evSession !== opts.currentSessionId) {
        opts.shards.apply(evSession, ev);
        continue;
      }
      if (ev.type === "queue/change") {
        opts.setQueuedCount(ev.snapshot.items.length);
        continue;
      }
      if (ev.type === "session/created") {
        // 会话 id 以 session/create 的响应为准；事件可能来自被取消的旧切换，不能覆盖当前会话。
        continue;
      }
      if (ev.type === "ask/request") {
        const a = ev as unknown as {
          requestId: string;
          tool: string;
          args: unknown;
          preview?: { path?: string; diff: string };
        };
        opts.setAsk({
          requestId: a.requestId,
          tool: a.tool,
          args: a.args,
          ...(a.preview !== undefined ? { preview: a.preview } : {}),
        });
        continue;
      }
      if (ev.type === "ask/cancelled") {
        opts.setAsk((prev) => (prev?.requestId === ev.requestId ? null : prev));
        continue;
      }
      if (ev.type === "plan/request") {
        opts.setPlan({ requestId: ev.requestId, plan: ev.plan });
        continue;
      }
      if (ev.type === "plan/cancelled") {
        opts.setPlan((prev) => (prev?.requestId === ev.requestId ? null : prev));
        continue;
      }
      if (ev.type === "question/request") {
        const q = ev as unknown as { requestId: string; question: QuestionState["question"] };
        opts.setQuestion({ requestId: q.requestId, question: q.question });
        continue;
      }
      if (ev.type === "session/event") {
        const se = ev.event as { type?: string; mode?: PermissionMode };
        if (se.mode !== undefined) opts.setMode(se.mode);
      }
      opts.setTimeline((prev) => applyEvent(prev, ev));
    }
  }, [conn.events, conn]);
}

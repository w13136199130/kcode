import { useEffect, useState } from "react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";

/**
 * 会话侧栏（M2a）：sessions/list 清单 + 时间分组（刚刚/今天/更早——modifiedAt）
 * + 新建会话（新窗口——窗口=会话的既定拓扑）。会话内切换/续接随 M2b。
 */
interface SessionSummary {
  sessionId: string;
  preview: string;
  turns: number;
  modifiedAt?: number;
}

function relativeTime(ts: number | undefined): string {
  if (ts === undefined) return "";
  const diff = Date.now() - ts;
  if (diff < 5 * 60_000) return "刚刚";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function groupOf(ts: number | undefined): string {
  if (ts === undefined) return "更早";
  const diff = Date.now() - ts;
  if (diff < 24 * 60 * 60_000) return "今天";
  if (diff < 7 * 24 * 60 * 60_000) return "本周";
  return "更早";
}

export function SessionSidebar(props: {
  conn: HostConnection;
  currentId: string | null;
  /** 点击历史会话 → 续接（M2b） */
  onOpen?(sessionId: string): void;
  /** 打开设置覆盖层（M3b） */
  onOpenSettings?(): void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  useEffect(() => {
    if (props.conn.status !== "ready") return;
    let cancelled = false;
    void props.conn
      .send("sessions/list")
      .then((r) => {
        if (cancelled) return;
        const list = r as { sessions?: SessionSummary[] };
        setSessions((list.sessions ?? []).slice(0, 100));
      })
      .catch(() => undefined);
    const timer = window.setInterval(() => {
      // 轻刷新：侧栏活跃度（会话完成后列表时间/排序更新）
      void props.conn
        .send("sessions/list")
        .then((r) => {
          if (cancelled) return;
          setSessions((r as { sessions?: SessionSummary[] }).sessions ?? []);
        })
        .catch(() => undefined);
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [props.conn.status, props.conn]);

  const groups: Array<{ label: string; items: SessionSummary[] }> = [];
  for (const s of sessions) {
    const g = groupOf(s.modifiedAt);
    const last = groups.at(-1);
    if (last !== undefined && last.label === g) last.items.push(s);
    else groups.push({ label: g, items: [s] });
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span>kcode</span>
        <button
          type="button"
          className="sidebar-new"
          title="新建会话（新窗口）"
          onClick={() => window.kcodeHost?.newWindow()}
        >
          ＋
        </button>
      </div>
      <div className="sidebar-list">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="sidebar-group">{g.label}</div>
            {g.items.map((s) => (
              <div
                key={s.sessionId}
                className={`sidebar-item ${s.sessionId === props.currentId ? "active" : ""}`}
                title={`${s.preview}（${s.turns} 轮）${props.onOpen !== undefined ? "——点击续接" : ""}`}
                onClick={() => props.onOpen?.(s.sessionId)}
                role="button"
              >
                <div className="sidebar-item-preview">{s.preview === "" ? "（空会话）" : s.preview}</div>
                <div className="sidebar-item-meta">
                  {relativeTime(s.modifiedAt)} · {s.turns} 轮
                </div>
              </div>
            ))}
          </div>
        ))}
        {sessions.length === 0 ? <div className="sidebar-empty">暂无历史会话</div> : null}
      </div>
      <div className="sidebar-foot">
        <button type="button" className="sidebar-settings" onClick={() => props.onOpenSettings?.()}>
          ⚙ 设置
        </button>
      </div>
    </aside>
  );
}

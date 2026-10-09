import { useEffect, useState } from "react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";

/**
 * 会话侧栏（M2a）：sessions/list 清单 + 新建会话（新窗口——窗口=会话的既定拓扑）。
 * 会话内切换/续接随 M2b（宿主单会话语义下的 resume 流）。虚拟化：
 * 会话数 <100 直接渲染（Codex 翻车在数百条；超阈值时再上 windowing）。
 */
interface SessionSummary {
  sessionId: string;
  preview: string;
  turns: number;
}

export function SessionSidebar(props: { conn: HostConnection; currentId: string | null }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  useEffect(() => {
    if (props.conn.status !== "ready") return;
    void props.conn
      .send("sessions/list")
      .then((r) => {
        const list = r as { sessions?: SessionSummary[] };
        setSessions([...(list.sessions ?? [])].slice(0, 100));
      })
      .catch(() => undefined);
  }, [props.conn.status, props.conn]);

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
        {sessions.map((s) => (
          <div
            key={s.sessionId}
            className={`sidebar-item ${s.sessionId === props.currentId ? "active" : ""}`}
            title={`${s.preview}（${s.turns} 轮）`}
          >
            <div className="sidebar-item-preview">{s.preview === "" ? "（空会话）" : s.preview}</div>
            <div className="sidebar-item-meta">{s.turns} 轮</div>
          </div>
        ))}
        {sessions.length === 0 ? <div className="sidebar-empty">暂无历史会话</div> : null}
      </div>
    </aside>
  );
}

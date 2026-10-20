import { useEffect, useState } from "react";
import { MessageSquare, Pencil, Plus, Settings, Trash2 } from "lucide-react";
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
  workspaceKey?: string;
  title?: string;
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
  /** D1-03：只展示当前工作区的会话（空 workspaceKey 的旧会话仍显示） */
  workspace?: string;
  /** 点击历史会话 → 同窗口续接 */
  onOpen?(sessionId: string): void;
  /** 新建会话 → 同窗口（不开新窗——反馈修订） */
  onNewSession?(): void;
  /** 打开设置覆盖层（M3b） */
  onOpenSettings?(): void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

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
  }, [props.conn.status, props.conn, refreshKey]);

  const workspaceKey = (props.workspace ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const visible =
    showAll || workspaceKey === ""
      ? sessions
      : sessions.filter((s) => s.workspaceKey === undefined || s.workspaceKey === "" || s.workspaceKey === workspaceKey);
  const groups: Array<{ label: string; items: SessionSummary[] }> = [];
  for (const s of visible) {
    const g = groupOf(s.modifiedAt);
    const last = groups.at(-1);
    if (last !== undefined && last.label === g) last.items.push(s);
    else groups.push({ label: g, items: [s] });
  }

  const saveTitle = async (id: string): Promise<void> => {
    try {
      await props.conn.send("sessions/rename", { sessionId: id, title: draftTitle });
      setEditingId(null);
      setRefreshKey((v) => v + 1);
    } catch {
      // 保留编辑态，让用户重试
    }
  };

  const removeSession = async (id: string): Promise<void> => {
    if (!window.confirm("删除这个会话？会话文件不可恢复。")) return;
    try {
      await props.conn.send("sessions/delete", { sessionId: id });
      setRefreshKey((v) => v + 1);
    } catch {
      // 当前会话由 host 拒绝；不做静默删除
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-brand">kcode</span>
        <button
          type="button"
          className="sidebar-scope"
          title={showAll ? "只显示当前项目" : "显示全部项目的会话"}
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? "全部" : "本项目"}
        </button>
        <button
          type="button"
          className="sidebar-new"
          title="新建会话（Ctrl+N）"
          onClick={() => props.onNewSession?.()}
        >
          <Plus size={15} strokeWidth={1.75} />
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
                title={`${s.title ?? s.preview}（${s.turns} 轮）${props.onOpen !== undefined ? "——点击续接" : ""}`}
                onClick={() => props.onOpen?.(s.sessionId)}
                role="button"
              >
                <div className="sidebar-item-preview">
                  <MessageSquare size={12} strokeWidth={1.75} className="sidebar-item-icon" />
                  {editingId === s.sessionId ? (
                    <input
                      className="sidebar-item-rename"
                      autoFocus
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") void saveTitle(s.sessionId);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      onBlur={() => setEditingId(null)}
                    />
                  ) : (
                    <span>{s.title ?? (s.preview === "" ? "（空会话）" : s.preview)}</span>
                  )}
                </div>
                <div className="sidebar-item-meta">
                  <span>
                    {relativeTime(s.modifiedAt)} · {s.turns} 轮
                  </span>
                  <span className="sidebar-item-actions">
                    <button
                      type="button"
                      title="重命名"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(s.sessionId);
                        setDraftTitle(s.title ?? s.preview);
                      }}
                    >
                      <Pencil size={12} strokeWidth={1.75} />
                    </button>
                    {s.sessionId !== props.currentId ? (
                      <button
                        type="button"
                        title="删除会话"
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeSession(s.sessionId);
                        }}
                      >
                        <Trash2 size={12} strokeWidth={1.75} />
                      </button>
                    ) : null}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ))}
        {visible.length === 0 ? <div className="sidebar-empty">暂无历史会话</div> : null}
      </div>
      <div className="sidebar-foot">
        <button type="button" className="sidebar-settings" onClick={() => props.onOpenSettings?.()}>
          <Settings size={14} strokeWidth={1.75} />
          设置
        </button>
      </div>
    </aside>
  );
}

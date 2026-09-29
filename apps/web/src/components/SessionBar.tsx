import { useEffect, useState } from "react";
import type { HostConnection } from "../hooks/useHostConnection.js";
import type { PermissionMode } from "@kcode/contracts";

/**
 * 会话管理栏（N3-3 完善）：模式切换 / 模型显示 / 会话列表 / 中断按钮。
 */
const MODES: { key: PermissionMode; label: string; color: string }[] = [
  { key: "plan", label: "只读", color: "var(--kcode-accent)" },
  { key: "default", label: "变更确认", color: "var(--kcode-warning)" },
  { key: "acceptEdits", label: "自动编辑", color: "var(--kcode-success)" },
  { key: "fullAccess", label: "完全访问", color: "var(--kcode-destructive)" },
];

export interface SessionInfo {
  sessionId: string;
  preview: string;
  turns: number;
}

export function SessionBar(props: {
  conn: HostConnection;
  sessionId: string | null;
  mode: PermissionMode;
  busy: boolean;
  onModeChange: (mode: PermissionMode) => void;
  onResume: (sessionId: string) => void;
  onInterrupt: () => void;
}) {
  const [showSessions, setShowSessions] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  const loadSessions = async (): Promise<void> => {
    try {
      const r = await props.conn.send("sessions/list") as { sessions: SessionInfo[] };
      setSessions(r.sessions);
      setShowSessions(true);
    } catch { /* 静默 */ }
  };

  const modeMeta = MODES.find((m) => m.key === props.mode) ?? MODES[1]!;

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: "10px",
      padding: "6px 16px",
      borderBottom: "1px solid var(--kcode-border)",
      fontSize: "13px",
    }}>
      {/* 品牌 */}
      <span style={{ fontWeight: 700, color: "var(--kcode-brand)" }}>kcode</span>

      {/* 连接状态 */}
      <span style={{
        color: props.conn.status === "ready" ? "var(--kcode-success)" : "var(--kcode-destructive)",
        fontSize: "11px",
      }}>
        {props.conn.status === "ready" ? "●" : "○"}
      </span>

      {/* 模式切换 */}
      <button
        onClick={() => {
          const idx = MODES.findIndex((m) => m.key === props.mode);
          props.onModeChange(MODES[(idx + 1) % MODES.length]!.key);
        }}
        style={{
          padding: "2px 10px",
          borderRadius: "4px",
          border: `1px solid ${modeMeta.color}`,
          color: modeMeta.color,
          background: "transparent",
          cursor: "pointer",
          fontSize: "12px",
        }}
        title="点击切换权限模式"
      >
        {modeMeta.label}
      </button>

      {/* 会话 */}
      <span style={{ color: "var(--kcode-foreground-subtle)" }}>
        {props.sessionId !== null ? props.sessionId.slice(0, 12) + "…" : "新会话"}
      </span>

      {/* 会话列表按钮 */}
      <button
        onClick={() => void loadSessions()}
        style={linkBtn}
        title="查看历史会话"
      >
        📂
      </button>

      {/* 中断按钮 */}
      {props.busy && (
        <button
          onClick={props.onInterrupt}
          style={{
            padding: "2px 10px",
            borderRadius: "4px",
            border: "1px solid var(--kcode-destructive)",
            color: "var(--kcode-destructive)",
            background: "transparent",
            cursor: "pointer",
            fontSize: "12px",
          }}
        >
          ■ 中断
        </button>
      )}

      <div style={{ flex: 1 }} />

      {/* 会话列表下拉 */}
      {showSessions && (
        <div style={{
          position: "fixed",
          top: "40px",
          right: "16px",
          width: "360px",
          maxHeight: "320px",
          overflowY: "auto",
          background: "var(--kcode-bg-panel)",
          border: "1px solid var(--kcode-border)",
          borderRadius: "8px",
          padding: "8px",
          zIndex: 100,
          boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
            <span style={{ fontWeight: 600 }}>历史会话</span>
            <button onClick={() => setShowSessions(false)} style={linkBtn}>✕</button>
          </div>
          {sessions.length === 0 && <div style={{ color: "var(--kcode-foreground-subtle)", padding: "8px" }}>暂无历史会话</div>}
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              onClick={() => {
                setShowSessions(false);
                props.onResume(s.sessionId);
              }}
              style={{
                display: "block",
                width: "100%",
                padding: "8px 10px",
                textAlign: "left",
                borderRadius: "4px",
                border: "none",
                background: s.sessionId === props.sessionId ? "var(--kcode-bg-subtle)" : "transparent",
                cursor: "pointer",
                color: "var(--kcode-foreground)",
                fontSize: "13px",
              }}
            >
              <div style={{ fontFamily: "monospace", fontSize: "11px", color: "var(--kcode-foreground-subtle)" }}>
                {s.sessionId.slice(0, 16)}… · {s.turns} 轮
              </div>
              <div>{s.preview || "（空）"}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const linkBtn: React.CSSProperties = {
  padding: "2px 6px",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: "var(--kcode-foreground-subtle)",
  fontSize: "14px",
};

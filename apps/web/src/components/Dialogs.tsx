import { useState } from "react";
import type { HostEvent, StructuredQuestion } from "@kcode/contracts";

/**
 * 交互面板集（N3-3 完善）：审批 / 计划批准 / 结构化提问。
 * 三种面板互斥显示——宿主同一时刻只发一种请求。
 */

// ---------- 审批面板 ----------

export function AskDialog(props: {
  request: Extract<HostEvent, { type: "ask/request" }>;
  onRespond: (allowed: boolean, scope?: "once" | "session" | "project") => void;
}) {
  const { request } = props;
  const argsPreview = JSON.stringify(request.args).slice(0, 160);
  return (
    <Dialog border="var(--kcode-interaction-ask)">
      <div style={{ fontWeight: 600, marginBottom: "8px", color: "var(--kcode-interaction-ask)" }}>
        ⚠ 允许 {request.tool}？
      </div>
      <pre style={previewStyle}>{argsPreview}</pre>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <DlgBtn color="var(--kcode-success)" onClick={() => props.onRespond(true)}>允许</DlgBtn>
        <DlgBtn color="var(--kcode-info)" onClick={() => props.onRespond(true, "session")}>本会话不再询问</DlgBtn>
        <DlgBtn color="var(--kcode-brand)" onClick={() => props.onRespond(true, "project")}>本项目不再询问</DlgBtn>
        <DlgBtn color="var(--kcode-destructive)" onClick={() => props.onRespond(false)}>拒绝</DlgBtn>
      </div>
    </Dialog>
  );
}

// ---------- 计划批准面板 ----------

export function PlanDialog(props: {
  request: Extract<HostEvent, { type: "plan/request" }>;
  onRespond: (choice: "approved" | "revise" | "abandon") => void;
}) {
  return (
    <Dialog border="var(--kcode-accent)">
      <div style={{ fontWeight: 600, marginBottom: "8px", color: "var(--kcode-accent)" }}>
        📋 执行计划（等待批准）
      </div>
      <div style={{
        padding: "12px",
        background: "var(--kcode-bg-subtle)",
        borderRadius: "6px",
        maxHeight: "300px",
        overflowY: "auto",
        marginBottom: "12px",
        whiteSpace: "pre-wrap",
        fontSize: "14px",
        lineHeight: 1.6,
      }}>
        {props.request.plan}
      </div>
      <div style={{ display: "flex", gap: "8px" }}>
        <DlgBtn color="var(--kcode-success)" onClick={() => props.onRespond("approved")}>批准并执行</DlgBtn>
        <DlgBtn color="var(--kcode-warning)" onClick={() => props.onRespond("revise")}>继续研究</DlgBtn>
        <DlgBtn color="var(--kcode-destructive)" onClick={() => props.onRespond("abandon")}>放弃</DlgBtn>
      </div>
    </Dialog>
  );
}

// ---------- 结构化提问面板 ----------

export function QuestionDialog(props: {
  request: Extract<HostEvent, { type: "question/request" }>;
  onRespond: (labels: string[]) => void;
}) {
  const q: StructuredQuestion = props.request.question;
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const multi = q.multiSelect === true;

  const toggle = (i: number): void => {
    setSelected((prev) => {
      if (!multi) return new Set([i]);
      const next = new Set(prev);
      if (next.has(i)) { next.delete(i); } else { next.add(i); }
      return next;
    });
  };

  return (
    <Dialog border="var(--kcode-interaction-ask)">
      <div style={{ fontWeight: 600, marginBottom: "8px", color: "var(--kcode-interaction-ask)" }}>
        ? {q.question}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "12px" }}>
        {q.options.map((opt, i) => (
          <button
            key={i}
            onClick={() => toggle(i)}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "8px",
              padding: "8px 12px",
              borderRadius: "6px",
              border: selected.has(i) ? "2px solid var(--kcode-brand)" : "1px solid var(--kcode-border)",
              background: selected.has(i) ? "var(--kcode-bg-subtle)" : "var(--kcode-bg-panel)",
              cursor: "pointer",
              textAlign: "left",
              fontSize: "14px",
              color: "var(--kcode-foreground)",
            }}
          >
            <span style={{ color: selected.has(i) ? "var(--kcode-brand)" : "var(--kcode-foreground-subtle)" }}>
              {multi ? (selected.has(i) ? "☒" : "☐") : selected.has(i) ? "●" : "○"}
            </span>
            <span>
              {opt.label}
              {opt.description !== undefined && (
                <span style={{ display: "block", fontSize: "12px", color: "var(--kcode-foreground-subtle)" }}>{opt.description}</span>
              )}
            </span>
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: "8px" }}>
        <DlgBtn
          color="var(--kcode-brand)"
          onClick={() => props.onRespond([...selected].sort((a, b) => a - b).map((i) => q.options[i]?.label ?? "").filter((l) => l !== ""))}
        >
          确认
        </DlgBtn>
        <DlgBtn color="var(--kcode-foreground-subtle)" onClick={() => props.onRespond([])}>取消</DlgBtn>
      </div>
    </Dialog>
  );
}

// ---------- 共享样式 ----------

function Dialog(props: { border: string; children: React.ReactNode }) {
  return (
    <div style={{
      padding: "16px",
      margin: "12px 0",
      borderRadius: "10px",
      border: `1px solid ${props.border}`,
      background: "var(--kcode-bg-panel)",
    }}>
      {props.children}
    </div>
  );
}

function DlgBtn(props: { color: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={props.onClick}
      style={{
        padding: "6px 14px",
        borderRadius: "6px",
        border: `1px solid ${props.color}`,
        background: "transparent",
        color: props.color,
        fontSize: "13px",
        cursor: "pointer",
      }}
    >
      {props.children}
    </button>
  );
}

const previewStyle: React.CSSProperties = {
  fontSize: "13px",
  fontFamily: "monospace",
  color: "var(--kcode-foreground-subtle)",
  marginBottom: "12px",
  padding: "8px",
  background: "var(--kcode-bg-subtle)",
  borderRadius: "4px",
  overflow: "auto",
  whiteSpace: "pre-wrap",
};

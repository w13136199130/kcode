import { useEffect, useRef, useState } from "react";
import type { HostEvent } from "@kcode/contracts";
import type { HostConnection } from "../hooks/useHostConnection.js";

/**
 * 聊天主界面（N3-3 最小可用版）：
 * - 转写区：user/assistant/tool/info 四种块渲染（DOM 版，替代 Ink 的 BlockView）
 * - 输入区：文本框 + 发送
 * - 状态行：busy/排队/连接状态
 */

interface Block {
  kind: "user" | "assistant" | "tool" | "info" | "stream";
  text: string;
  tone?: "ok" | "deny" | "warn";
}

export function Chat({ conn }: { conn: HostConnection }) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [streamText, setStreamText] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // 已处理事件偏移——events 是累积数组，effect 每次只处理新增部分（否则旧事件重复渲染）
  const processedRef = useRef(0);
  // streamText 的同步镜像（在 useEffect 里读 state 会拿到旧值）
  const streamTextRef = useRef("");
  streamTextRef.current = streamText;

  // 事件流 → 块列表（增量处理：只消费 slice(processedRef.current) 的新事件）
  useEffect(() => {
    const newEvents = conn.events.slice(processedRef.current);
    processedRef.current = conn.events.length;
    for (const ev of newEvents) {
      switch (ev.type) {
        case "session/created":
          setSessionId(ev.sessionId);
          setBlocks([]);
          setStreamText("");
          break;
        case "session/event": {
          const se = ev.event as { type?: string; content?: string; text?: string; output?: string; tool?: string; tone?: string };
          if (se.type === "user_message") {
            setBlocks((b) => [...b, { kind: "user", text: se.content ?? "" }]);
          } else if (se.type === "assistant_message") {
            setBlocks((b) => [...b, { kind: "assistant", text: se.content ?? "" }]);
          } else if (se.type === "tool_call") {
            setBlocks((b) => [...b, { kind: "tool", text: `⚙ ${se.tool ?? "unknown"}…` }]);
          } else if (se.type === "tool_result") {
            // 用函数式更新读最新 blocks，避免闭包里的旧值
            setBlocks((b) => {
              const last = b.at(-1);
              if (last !== undefined && last.kind === "tool") {
                return [...b.slice(0, -1), { kind: "tool", text: `${last.text} ${se.output?.slice(0, 200) ?? ""}` }];
              }
              return [...b, { kind: "info", text: se.output?.slice(0, 200) ?? "" }];
            });
          } else if (se.type === "llm_error") {
            setBlocks((b) => [...b, { kind: "info", text: `✗ 模型调用失败：${se.text ?? ""}`, tone: "warn" }]);
          } else if (se.type === "session_end") {
            setBusy(false);
          }
          break;
        }
        case "delta":
          setStreamText((prev) => prev + ev.text);
          break;
        case "session/summary":
          // 一轮完成：流式缓冲定格为 assistant 块（不在 setState 回调里做副作用）
          setBlocks((b) => {
            const current = streamTextRef.current;
            return current !== "" ? [...b, { kind: "assistant", text: current }] : b;
          });
          setStreamText("");
          setBusy(false);
          break;
        case "notice":
          setBlocks((b) => [...b, { kind: "info", text: ev.message }]);
          break;
        case "host/closing":
          setBlocks((b) => [...b, { kind: "info", text: `⚠ ${ev.reason}`, tone: "warn" }]);
          break;
        default:
          break;
      }
    }
  }, [conn.events]);

  // 自动滚动到底
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [blocks, streamText]);

  // 创建会话（连接就绪后自动）
  useEffect(() => {
    if (conn.status === "ready" && sessionId === null) {
      const model = new URLSearchParams(window.location.search).get("model") ?? "test/echo";
      void conn.send("session/create", { model, cwd: "/" }).then((r) => {
        void r;
      }).catch(() => {
        // 会话创建失败：状态栏会显示连接错误，此处不额外打印
      });
    }
  }, [conn.status, sessionId, conn]);

  const submit = async (): Promise<void> => {
    const text = input.trim();
    if (text === "" || busy) return;
    setInput("");
    setBusy(true);
    try {
      await conn.send("session/submit", { text });
    } catch (e) {
      setBlocks((b) => [...b, { kind: "info", text: `✗ 发送失败：${e instanceof Error ? e.message : String(e)}`, tone: "warn" }]);
      setBusy(false);
    }
  };

  const color = (tone?: string): string => {
    if (tone === "ok") return "var(--kcode-success, #22c55e)";
    if (tone === "warn") return "var(--kcode-warning, #f59e0b)";
    if (tone === "deny") return "var(--kcode-destructive, #ef4444)";
    return "inherit";
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", maxWidth: "860px", margin: "0 auto", fontFamily: "system-ui, sans-serif" }}>
      {/* 状态栏 */}
      <div style={{ padding: "8px 16px", borderBottom: "1px solid #e5e7eb", fontSize: "13px", color: "#6b7280", display: "flex", gap: "12px" }}>
        <span>kcode web</span>
        <span>·</span>
        <span style={{ color: conn.status === "ready" ? "#22c55e" : conn.status === "error" ? "#ef4444" : "#f59e0b" }}>
          {conn.status === "ready" ? "已连接" : conn.status === "connecting" ? "连接中…" : conn.status === "closed" ? "已断开" : "错误"}
        </span>
        {sessionId !== null && <span>· {sessionId.slice(0, 16)}…</span>}
        {busy && <span>· 运行中…</span>}
      </div>

      {/* 转写区 */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px" }}>
        {blocks.map((b, i) => (
          <div key={i} style={{ marginBottom: "12px" }}>
            {b.kind === "user" && (
              <div style={{ background: "#f3f4f6", borderRadius: "8px", padding: "10px 14px", marginLeft: "40px" }}>
                <span style={{ fontSize: "12px", color: "#9ca3af" }}>你</span>
                <div style={{ whiteSpace: "pre-wrap" }}>{b.text}</div>
              </div>
            )}
            {b.kind === "assistant" && (
              <div style={{ padding: "10px 14px" }}>
                <span style={{ fontSize: "12px", color: "#9ca3af" }}>kcode</span>
                <div style={{ whiteSpace: "pre-wrap" }}>{b.text}</div>
              </div>
            )}
            {b.kind === "tool" && (
              <div style={{ padding: "6px 14px", fontSize: "13px", color: "#6b7280", fontFamily: "monospace", background: "#f9fafb", borderRadius: "4px" }}>
                {b.text}
              </div>
            )}
            {b.kind === "info" && (
              <div style={{ padding: "6px 14px", fontSize: "13px", color: color(b.tone) }}>
                {b.text}
              </div>
            )}
          </div>
        ))}
        {streamText !== "" && (
          <div style={{ padding: "10px 14px", opacity: 0.8 }}>
            <span style={{ fontSize: "12px", color: "#9ca3af" }}>kcode（流式）</span>
            <div style={{ whiteSpace: "pre-wrap" }}>{streamText}</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 输入区 */}
      <div style={{ padding: "16px", borderTop: "1px solid #e5e7eb" }}>
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={busy ? "运行中…（等待完成）" : "输入你的问题…"}
            disabled={busy || conn.status !== "ready"}
            style={{
              flex: 1,
              padding: "10px 14px",
              borderRadius: "8px",
              border: "1px solid #d1d5db",
              fontSize: "14px",
              outline: "none",
              background: busy ? "#f9fafb" : "white",
            }}
          />
          <button
            onClick={() => void submit()}
            disabled={busy || input.trim() === "" || conn.status !== "ready"}
            style={{
              padding: "10px 20px",
              borderRadius: "8px",
              border: "none",
              background: busy ? "#e5e7eb" : "#3b82f6",
              color: busy ? "#9ca3af" : "white",
              fontSize: "14px",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}

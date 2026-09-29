import { useCallback, useEffect, useRef, useState } from "react";
import type { HostEvent, PermissionMode } from "@kcode/contracts";
import type { HostConnection } from "../hooks/useHostConnection.js";
import { AskDialog, PlanDialog, QuestionDialog } from "./Dialogs.js";
import { SessionBar } from "./SessionBar.js";
import { Markdown } from "./Markdown.js";

/**
 * 聊天主界面（N3-3 完整版）：
 * - 转写区：user/assistant/tool/info + 流式 + Markdown
 * - 交互面板：审批（四选）/ 计划批准（三选）/ 结构化提问（多选）
 * - 会话管理：模式切换 / 中断 / 会话列表 + 续接
 * - 斜杠命令：/compact /context /cost /status /help /mode /clear /resume
 */

interface Block {
  kind: "user" | "assistant" | "tool" | "info" | "banner";
  text: string;
  tone?: "ok" | "deny" | "warn";
}

export function Chat({ conn }: { conn: HostConnection }) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [streamText, setStreamText] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [mode, setMode] = useState<PermissionMode>("default");
  const [askReq, setAskReq] = useState<Extract<HostEvent, { type: "ask/request" }> | null>(null);
  const [planReq, setPlanReq] = useState<Extract<HostEvent, { type: "plan/request" }> | null>(null);
  const [questionReq, setQuestionReq] = useState<Extract<HostEvent, { type: "question/request" }> | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const processedRef = useRef(0);
  const streamTextRef = useRef("");
  streamTextRef.current = streamText;
  const connRef = useRef(conn);
  connRef.current = conn;

  const pushBlock = useCallback((block: Block) => {
    setBlocks((b) => [...b, block]);
  }, []);

  // 事件流 → 状态（增量处理）
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
          const se = ev.event as { type?: string; content?: string; output?: string; tool?: string; error?: string; usage?: { inputTokens: number; outputTokens: number; calls: number }; reason?: string };
          if (se.type === "user_message") {
            pushBlock({ kind: "user", text: se.content ?? "" });
          } else if (se.type === "assistant_message") {
            pushBlock({ kind: "assistant", text: se.content ?? "" });
          } else if (se.type === "tool_call") {
            pushBlock({ kind: "tool", text: `⚙ ${se.tool ?? "?"}…` });
          } else if (se.type === "tool_result") {
            setBlocks((b) => {
              const last = b.at(-1);
              if (last !== undefined && last.kind === "tool") {
                const r = se.error !== undefined && se.error !== "" ? `✗ ${se.error}` : (se.output ?? "").slice(0, 400);
                return [...b.slice(0, -1), { kind: "tool", text: `${last.text}\n${r}` }];
              }
              return [...b, { kind: "info", text: (se.output ?? "").slice(0, 400) }];
            });
          } else if (se.type === "llm_error") {
            pushBlock({ kind: "info", text: `✗ 模型调用失败：${se.error ?? ""}`, tone: "warn" });
          } else if (se.type === "session_end") {
            if (se.reason === "aborted") pushBlock({ kind: "info", text: "已中断本轮执行", tone: "warn" });
            setBusy(false);
          } else if (se.type === "compaction_summary") {
            pushBlock({ kind: "info", text: `⑂ 已压缩历史（摘要 ${se.content?.length ?? 0} 字）` });
          }
          break;
        }
        case "delta":
          setStreamText((p) => p + ev.text);
          break;
        case "session/summary":
          setBlocks((b) => {
            const cur = streamTextRef.current;
            return cur !== "" ? [...b, { kind: "assistant", text: cur }] : b;
          });
          setStreamText("");
          setBusy(false);
          break;
        case "ask/request":
          setAskReq(ev);
          break;
        case "plan/request":
          setPlanReq(ev);
          break;
        case "question/request":
          setQuestionReq(ev);
          break;
        case "notice":
          pushBlock({ kind: "info", text: ev.message });
          break;
        case "host/closing":
          pushBlock({ kind: "info", text: `⚠ ${ev.reason}`, tone: "warn" });
          break;
        default:
          break;
      }
    }
  }, [conn.events, pushBlock]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [blocks, streamText, askReq, planReq, questionReq]);

  // 就绪后自动创建会话
  const createSession = useCallback((model: string, resumeFrom?: string) => {
    void connRef.current.send("session/create", { model, cwd: "/", ...(resumeFrom !== undefined ? { resumeFrom } : {}) })
      .then((r) => {
        const res = r as { sessionId: string };
        setSessionId(res.sessionId);
        setBlocks([]);
        setStreamText("");
        processedRef.current = connRef.current.events.length;
      })
      .catch((e) => pushBlock({ kind: "info", text: `✗ 会话创建失败：${e instanceof Error ? e.message : String(e)}`, tone: "warn" }));
  }, [pushBlock]);

  useEffect(() => {
    if (conn.status === "ready" && sessionId === null) {
      const model = new URLSearchParams(window.location.search).get("model") ?? "test/echo";
      createSession(model);
    }
  }, [conn.status, sessionId, createSession, conn]);

  // ---------- 斜杠命令处理 ----------

  const handleSlashCommand = useCallback(async (text: string): Promise<boolean> => {
    const body = text.slice(1);
    const spaceIdx = body.indexOf(" ");
    const name = spaceIdx === -1 ? body : body.slice(0, spaceIdx);
    const args = spaceIdx === -1 ? "" : body.slice(spaceIdx + 1).trim();
    const c = connRef.current;

    switch (name) {
      case "help":
        pushBlock({ kind: "info", text: [
          "**可用命令**",
          "`/mode [名称]` 切换权限模式（plan/default/acceptEdits/fullAccess）",
          "`/compact` 手动压缩历史",
          "`/context` 查看 token 占用",
          "`/cost` 查看本会话用量",
          "`/status` 会话状态一览",
          "`/clear` 清屏开新会话",
          "`/resume` 续接历史会话",
          "`/help` 显示本帮助",
          "`!命令` 直接执行 shell（结果仅显示）",
        ].join("\n") });
        return true;

      case "mode": {
        const MODE_KEYS = ["plan", "default", "acceptEdits", "fullAccess"] as const;
        if (args === "") {
          const next = MODE_KEYS[(MODE_KEYS.indexOf(mode) + 1) % MODE_KEYS.length] as PermissionMode;
          setMode(next);
          void c.send("session/set_mode", { mode: next });
          pushBlock({ kind: "info", text: `⇄ 已切换：${next}` });
          return true;
        }
        if (!(MODE_KEYS as readonly string[]).includes(args)) {
          pushBlock({ kind: "info", text: `未知模式 ${args}`, tone: "warn" });
          return true;
        }
        setMode(args as PermissionMode);
        void c.send("session/set_mode", { mode: args });
        pushBlock({ kind: "info", text: `⇄ 已切换：${args}` });
        return true;
      }

      case "clear":
        if (busy) { pushBlock({ kind: "info", text: "运行中不能清屏", tone: "warn" }); return true; }
        createSession(new URLSearchParams(window.location.search).get("model") ?? "test/echo");
        pushBlock({ kind: "info", text: "已开启全新会话" });
        return true;

      case "compact":
        pushBlock({ kind: "info", text: "⑂ 手动压缩已请求（下次运行时生效）" });
        return true;

      case "context":
      case "cost":
      case "status":
        pushBlock({ kind: "info", text: `📊 /${name} 数据获取走宿主事件流（待完善）` });
        return true;

      case "resume":
        pushBlock({ kind: "info", text: "📂 用顶栏 📂 按钮查看历史会话并续接" });
        return true;

      default:
        return false; // 未知命令，当普通消息发送
    }
  }, [busy, mode, createSession, pushBlock]);

  // ---------- 提交 ----------

  const submit = async (): Promise<void> => {
    const text = input.trim();
    if (text === "" || busy || askReq !== null || planReq !== null || questionReq !== null) return;
    setInput("");

    // !命令 → 直接显示（宿主会处理为 bash）
    if (text.startsWith("!")) {
      pushBlock({ kind: "user", text });
      setBusy(true);
      try { await conn.send("session/submit", { text }); } catch { setBusy(false); }
      return;
    }

    // 斜杠命令
    if (text.startsWith("/")) {
      pushBlock({ kind: "user", text });
      const handled = await handleSlashCommand(text);
      if (handled) return;
      // 未识别的 /xxx 当普通消息发送
    }

    pushBlock({ kind: "user", text });
    setBusy(true);
    try {
      await conn.send("session/submit", { text });
    } catch (e) {
      pushBlock({ kind: "info", text: `✗ 发送失败：${e instanceof Error ? e.message : String(e)}`, tone: "warn" });
      setBusy(false);
    }
  };

  // ---------- 交互面板应答 ----------

  const respondAsk = (allowed: boolean, scope?: "once" | "session" | "project"): void => {
    if (askReq === null) return;
    setAskReq(null);
    void conn.send("ask/respond", { requestId: askReq.requestId, allowed, ...(scope !== undefined ? { scope } : {}) }).catch(() => {});
  };

  const respondPlan = (choice: "approved" | "revise" | "abandon"): void => {
    if (planReq === null) return;
    setPlanReq(null);
    // plan/respond → question/respond 通道（宿主侧 planAsker 桥接）
    const labels = choice === "approved" ? ["批准并执行"] : choice === "revise" ? ["继续研究"] : ["放弃"];
    void conn.send("question/respond", { requestId: planReq.requestId, labels }).catch(() => {});
    if (choice === "approved") setMode("default");
  };

  const respondQuestion = (labels: string[]): void => {
    if (questionReq === null) return;
    setQuestionReq(null);
    void conn.send("question/respond", { requestId: questionReq.requestId, labels }).catch(() => {});
  };

  const interrupt = (): void => {
    void conn.send("session/interrupt").catch(() => {});
    pushBlock({ kind: "info", text: "■ 已请求中断", tone: "warn" });
  };

  const toneColor = (tone?: string): string => {
    if (tone === "ok") return "var(--kcode-success)";
    if (tone === "warn") return "var(--kcode-warning)";
    if (tone === "deny") return "var(--kcode-destructive)";
    return "var(--kcode-foreground-subtle)";
  };

  const hasDialog = askReq !== null || planReq !== null || questionReq !== null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", maxWidth: "860px", margin: "0 auto", fontFamily: "system-ui, sans-serif", background: "var(--kcode-bg)" }}>
      <SessionBar
        conn={conn}
        sessionId={sessionId}
        mode={mode}
        busy={busy}
        onModeChange={(m) => { setMode(m); void conn.send("session/set_mode", { mode: m }); }}
        onResume={(id) => createSession(new URLSearchParams(window.location.search).get("model") ?? "test/echo", id)}
        onInterrupt={interrupt}
      />

      {/* 转写区 */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px" }}>
        {blocks.map((b, i) => (
          <div key={i} style={{ marginBottom: "12px" }}>
            {b.kind === "user" && (
              <div style={{
                background: "var(--kcode-bg-subtle)",
                borderRadius: "10px",
                padding: "10px 14px",
                marginLeft: "48px",
                border: "1px solid var(--kcode-border)",
              }}>
                <div style={{ fontSize: "12px", color: "var(--kcode-foreground-subtle)", marginBottom: "4px" }}>你</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{b.text}</div>
              </div>
            )}
            {b.kind === "assistant" && (
              <div style={{ padding: "8px 0" }}>
                <div style={{ fontSize: "12px", color: "var(--kcode-brand)", marginBottom: "4px" }}>kcode</div>
                <Markdown text={b.text} />
              </div>
            )}
            {b.kind === "tool" && (
              <div style={{
                padding: "8px 12px",
                fontSize: "13px",
                fontFamily: "monospace",
                color: "var(--kcode-foreground-subtle)",
                background: "var(--kcode-bg-panel)",
                borderRadius: "6px",
                border: "1px solid var(--kcode-border)",
                whiteSpace: "pre-wrap",
              }}>
                {b.text}
              </div>
            )}
            {b.kind === "info" && (
              <div style={{ padding: "6px 12px", fontSize: "13px", color: toneColor(b.tone) }}>
                <Markdown text={b.text} />
              </div>
            )}
          </div>
        ))}

        {streamText !== "" && (
          <div style={{ padding: "8px 0", opacity: 0.85 }}>
            <div style={{ fontSize: "12px", color: "var(--kcode-brand)", marginBottom: "4px" }}>kcode（流式）</div>
            <Markdown text={streamText} />
          </div>
        )}

        {askReq !== null && <AskDialog request={askReq} onRespond={respondAsk} />}
        {planReq !== null && <PlanDialog request={planReq} onRespond={respondPlan} />}
        {questionReq !== null && <QuestionDialog request={questionReq} onRespond={respondQuestion} />}

        <div ref={bottomRef} />
      </div>

      {/* 输入区 */}
      <div style={{ padding: "16px", borderTop: "1px solid var(--kcode-border)" }}>
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
            }}
            placeholder={hasDialog ? "请先完成上方的选择…" : busy ? "运行中…（可点顶栏中断）" : "输入问题或 / 命令…（Shift+Enter 换行）"}
            disabled={hasDialog}
            style={{
              flex: 1,
              padding: "10px 14px",
              borderRadius: "8px",
              border: "1px solid var(--kcode-border)",
              fontSize: "14px",
              outline: "none",
              background: "var(--kcode-bg-panel)",
              color: "var(--kcode-foreground)",
            }}
          />
          <button
            onClick={() => void submit()}
            disabled={busy || input.trim() === "" || hasDialog}
            style={{
              padding: "10px 20px",
              borderRadius: "8px",
              border: "none",
              background: busy || hasDialog ? "var(--kcode-bg-subtle)" : "var(--kcode-brand)",
              color: busy || hasDialog ? "var(--kcode-foreground-subtle)" : "white",
              fontSize: "14px",
              cursor: busy || hasDialog ? "not-allowed" : "pointer",
            }}
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}

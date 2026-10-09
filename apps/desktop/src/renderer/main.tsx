import { createRoot } from "react-dom/client";
import { webCssTheme } from "@kcode/design";
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import type { PermissionMode, SessionEvent } from "@kcode/contracts";
import { useDesktopConnection } from "./hooks/useDesktopConnection.js";
import { WorkspaceLayout } from "./components/WorkspaceLayout.js";
import { SessionSidebar } from "./components/SessionSidebar.js";
import { WorkspaceHeader } from "./components/WorkspaceHeader.js";
import { Timeline } from "./components/Timeline.js";
import { Composer } from "./components/Composer.js";
import { AskPanel, QuestionPanel } from "./components/AskPanel.js";
import { applyEvent, initialTimeline, type TimelineState } from "./components/projection.js";
import { CommandPalette } from "./components/CommandPalette.js";
import "./styles.css";

/**
 * kcode 桌面 renderer（M2b，§8.4h）：在 M2a 三栏之上补交互闭环——
 * 审批四档面板（N3I-5 参数级规则内联）、ask_user 结构化提问弹层、
 * 转写重放（reload 后 session/replay 恢复历史）、会话切换/续接（侧栏点击 → resume）。
 */
const styleEl = document.createElement("style");
styleEl.textContent = webCssTheme();
document.head.appendChild(styleEl);

interface AskState {
  requestId: string;
  tool: string;
  args: unknown;
}
interface QuestionState {
  requestId: string;
  question: { question: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean };
}

function DesktopApp() {
  const conn = useDesktopConnection();
  const [timeline, setTimeline] = useState<TimelineState>(initialTimeline);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [modelDefault, setModelDefault] = useState<string | null>(null);
  const [mode, setMode] = useState<PermissionMode>("default");
  const [ask, setAsk] = useState<AskState | null>(null);
  const [question, setQuestion] = useState<QuestionState | null>(null);
  const [defaultCwd, setDefaultCwd] = useState("");
  /** 会话版本号：切换/续接时 +1——触发投影重置与重放 */
  const [sessionVersion, setSessionVersion] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // 系统通知（M3a）：仅在窗口失焦时发——任务完成 / 待审批（沿检测去重）
  const prevBusyRef = useRef(timeline.busy);
  const prevAskRef = useRef<string | null>(null);
  useEffect(() => {
    const focused = document.hasFocus();
    if (prevBusyRef.current === true && timeline.busy === false && !focused) {
      window.kcodeHost?.notify("kcode", "任务已完成");
    }
    prevBusyRef.current = timeline.busy;
    const askId = ask?.requestId ?? null;
    if (askId !== null && prevAskRef.current !== askId && !focused) {
      window.kcodeHost?.notify("kcode", `等待审批：${ask.tool}`);
    }
    prevAskRef.current = askId;
  }, [timeline.busy, ask]);

  // 全局快捷键（capture；命令面板 / 新窗口 / 侧栏）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (k === "n") {
        e.preventDefault();
        window.kcodeHost?.newWindow();
      } else if (k === "b") {
        e.preventDefault();
        setSidebarCollapsed((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const createdRef = useRef(false);
  const processed = useRef(0);

  useEffect(() => {
    void window.kcodeHost?.getDefaultModel().then(setModelDefault);
    void window.kcodeHost?.getDefaultCwd().then(setDefaultCwd);
  }, []);

  // ready 即建会话（host 幂等——reload/StrictMode 重挂安全）
  useEffect(() => {
    if (conn.status !== "ready" || createdRef.current || modelDefault === null || defaultCwd === "") return;
    createdRef.current = true;
    void conn
      .send("session/create", { model: modelDefault, cwd: defaultCwd })
      .then((r) => setSessionId((r as { sessionId: string }).sessionId))
      .catch(() => undefined);
  }, [conn.status, modelDefault, defaultCwd, conn]);

  // 转写重放（M2b）：会话就绪后拉一次全量事件重建时间线（reload/切换后续接都走这里）
  useEffect(() => {
    if (conn.status !== "ready" || sessionId === null) return;
    let cancelled = false;
    void conn
      .send("session/replay")
      .then((r) => {
        if (cancelled) return;
        const { events } = r as { sessionId: string; events: SessionEvent[] };
        let state = initialTimeline();
        for (const ev of events) state = applyEvent(state, ev);
        setTimeline(state);
        processed.current = conn.events.length; // 重放已含直播期事件——跳过存量
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // sessionVersion 变化（切换续接）时重放
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.status, sessionId, sessionVersion]);

  // 事件流 → 投影（增量）
  useEffect(() => {
    const news = conn.events.slice(processed.current);
    processed.current = conn.events.length;
    if (news.length === 0) return;
    for (const ev of news) {
      if (ev.type === "session/created") {
        setSessionId(ev.sessionId);
        continue;
      }
      if (ev.type === "ask/request") {
        const a = ev as unknown as { requestId: string; tool: string; args: unknown };
        setAsk({ requestId: a.requestId, tool: a.tool, args: a.args });
        continue;
      }
      if (ev.type === "question/request") {
        const q = ev as unknown as { requestId: string; question: QuestionState["question"] };
        setQuestion({ requestId: q.requestId, question: q.question });
        continue;
      }
      if (ev.type === "session/event") {
        const se = ev.event as { type?: string; mode?: PermissionMode };
        if (se.mode !== undefined) setMode(se.mode);
      }
      setTimeline((prev) => applyEvent(prev, ev));
    }
  }, [conn.events, conn]);

  const onSend = (text: string): void => {
    setTimeline((prev) => ({ ...prev, busy: true }));
    void conn.send("session/submit", { text }).catch(() => setTimeline((prev) => ({ ...prev, busy: false })));
  };

  const onStop = (): void => {
    void conn.send("session/interrupt").catch(() => undefined);
  };

  /** 会话续接（M2b）：侧栏点击 → resume 重建（宿主单会话语义下重开同会话） */
  const onResume = useCallback(
    (id: string): void => {
      if (modelDefault === null || defaultCwd === "") return;
      void conn
        .send("session/create", { model: modelDefault, cwd: defaultCwd, resumeFrom: id })
        .then(() => {
          setSessionId(id);
          setSessionVersion((v) => v + 1); // 触发重放
        })
        .catch(() => undefined);
    },
    [conn, modelDefault, defaultCwd],
  );

  const ready = conn.status === "ready" && sessionId !== null;

  if (conn.status === "error") {
    return <div className="center-note">⚠ 宿主连接失败：{conn.error}</div>;
  }
  if (conn.status === "closed") {
    return (
      <div className="center-note">
        宿主进程已退出（会话随之结束）。
        <br />
        <span className="dim">关闭本窗口再开新窗口即可启动新会话。</span>
      </div>
    );
  }

  return (
    <>
      <WorkspaceLayout
      collapsed={sidebarCollapsed}
      onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
      sidebar={
        <SessionSidebar
          conn={conn}
          currentId={sessionId}
          onOpen={onResume}
        />
      }
      main={
        <div className="main-column">
          <WorkspaceHeader title="kcode" model={modelDefault} mode={mode} />
          <div className="timeline-stack">
            <Timeline state={timeline} />
            {ask !== null ? (
              <AskPanel
                tool={ask.tool}
                args={ask.args}
                onRespond={(allowed, scope) => {
                  setAsk(null);
                  void conn.send("ask/respond", { requestId: ask.requestId, allowed, scope }).catch(() => undefined);
                }}
              />
            ) : null}
            {question !== null ? (
              <QuestionPanel
                question={question.question}
                onRespond={(labels) => {
                  setQuestion(null);
                  void conn.send("question/respond", { requestId: question.requestId, labels }).catch(() => undefined);
                }}
              />
            ) : null}
          </div>
          <Composer
            busy={timeline.busy}
            disabled={!ready}
            queuedCount={0}
            mode={mode}
            model={modelDefault}
            onModeChange={(m) => {
              setMode(m);
              void conn.send("session/set_mode", { mode: m }).catch(() => undefined);
            }}
            onSend={onSend}
            onStop={onStop}
          />
        </div>
      }
    />
      {paletteOpen ? (
        <CommandPalette
          mode={mode}
          onClose={() => setPaletteOpen(false)}
          onNewWindow={() => window.kcodeHost?.newWindow()}
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
          onInterrupt={onStop}
          onModeChange={(m) => {
            setMode(m);
            void conn.send("session/set_mode", { mode: m }).catch(() => undefined);
          }}
        />
      ) : null}
    </>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <DesktopApp />
  </StrictMode>,
);

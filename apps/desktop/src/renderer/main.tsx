import { createRoot } from "react-dom/client";
import { webCssTheme } from "@kcode/design";
import { StrictMode, useEffect, useRef, useState } from "react";
import type { PermissionMode } from "@kcode/contracts";
import { useDesktopConnection } from "./hooks/useDesktopConnection.js";
import { WorkspaceLayout } from "./components/WorkspaceLayout.js";
import { SessionSidebar } from "./components/SessionSidebar.js";
import { WorkspaceHeader } from "./components/WorkspaceHeader.js";
import { Timeline } from "./components/Timeline.js";
import { Composer } from "./components/Composer.js";
import { applyEvent, initialTimeline, type TimelineState } from "./components/projection.js";
import "./styles.css";

/**
 * kcode 桌面 renderer（M2a，§8.4h 三栏重建）：侧栏（会话列表）+ 主区
 * （顶栏 / 虚拟时间线 / Composer）。连接层沿用 M1 的 MessagePort 桥。
 * 审批暂以系统确认框保底（允许/拒绝），四档面板与 plan/ask_user 弹层随 M2b。
 */
const styleEl = document.createElement("style");
styleEl.textContent = webCssTheme();
document.head.appendChild(styleEl);

function DesktopApp() {
  const conn = useDesktopConnection();
  const [timeline, setTimeline] = useState<TimelineState>(initialTimeline);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [modelDefault, setModelDefault] = useState<string | null>(null);
  const [mode, setMode] = useState<PermissionMode>("default");
  const createdRef = useRef(false);
  const processed = useRef(0);

  // 用户级默认模型与默认工作目录（preload IPC；M2a = homedir，工作区选择器 M2b）
  const [defaultCwd, setDefaultCwd] = useState("");
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

  // 事件流 → 投影（增量；直播流在 Timeline 内渲染）
  useEffect(() => {
    const news = conn.events.slice(processed.current);
    processed.current = conn.events.length;
    for (const ev of news) {
      setTimeline((prev) => applyEvent(prev, ev));
      if (ev.type === "session/created") setSessionId(ev.sessionId);
      if (ev.type === "session/event") {
        const se = ev.event as { type?: string; mode?: PermissionMode };
        if (se.mode !== undefined) setMode(se.mode);
      }
      if (ev.type === "ask/request") {
        const call = (ev as unknown as { call?: { tool?: string; args?: unknown } }).call;
        const label = `${call?.tool ?? "工具"} ${JSON.stringify(call?.args ?? {}).slice(0, 200)}`;
        const allowed = window.confirm(`允许工具调用？\n${label}`);
        void conn.send("ask/respond", { requestId: (ev as { requestId: string }).requestId, allowed }).catch(
          () => undefined,
        );
      }
    }
  }, [conn.events, conn]);

  const onSend = (text: string): void => {
    setTimeline((prev) => ({ ...prev, busy: true }));
    void conn.send("session/submit", { text }).catch(() => setTimeline((prev) => ({ ...prev, busy: false })));
  };

  const onStop = (): void => {
    void conn.send("session/interrupt").catch(() => undefined);
  };

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
    <WorkspaceLayout
      sidebar={<SessionSidebar conn={conn} currentId={sessionId} />}
      main={
        <div className="main-column">
          <WorkspaceHeader title="kcode" model={modelDefault} mode={mode} />
          <Timeline state={timeline} />
          <Composer busy={timeline.busy} disabled={!ready} queuedCount={0} onSend={onSend} onStop={onStop} />
        </div>
      }
    />
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <DesktopApp />
  </StrictMode>,
);

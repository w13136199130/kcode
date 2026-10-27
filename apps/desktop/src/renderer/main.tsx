import { createRoot } from "react-dom/client";
import { desktopClassicTheme, desktopCssTheme, webCssTheme } from "@kcode/design";
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import type { PermissionMode } from "@kcode/contracts";
import { useDesktopConnection } from "./hooks/useDesktopConnection.js";
import { useDesktopSessionSwitching } from "./hooks/useDesktopSessionSwitching.js";
import { WorkspaceLayout } from "./components/WorkspaceLayout.js";
import { SessionSidebar } from "./components/SessionSidebar.js";
import { DesktopSidebar } from "./components/DesktopSidebar.js";
import { WorkspaceHeader } from "./components/WorkspaceHeader.js";
import { Composer } from "./components/Composer.js";
import { AskPanel, QuestionPanel } from "./components/AskPanel.js";
import { PlanPanel } from "./components/PlanPanel.js";
import { initialTimeline, type TimelineState } from "./components/projection.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { useWorkspacePanes } from "./hooks/useWorkspacePanes.js";
import { useCommandCatalog } from "./hooks/useCommandCatalog.js";
import { useDesktopCommands } from "./hooks/useDesktopCommands.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { EmptyState } from "./components/EmptyState.js";
import { CreateFailureCard } from "./components/CreateFailureCard.js";
import { TrustBanner } from "./components/TrustBanner.js";
import { useBootSession } from "./hooks/useBootSession.js";
import { useSessionReplay } from "./hooks/useSessionReplay.js";
import { useWorkspaceTrust } from "./hooks/useWorkspaceTrust.js";
import { useModelPicker } from "./hooks/useModelPicker.js";
import { useSessionContext } from "./hooks/useSessionContext.js";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts.js";
import { useInitialConfig } from "./hooks/useInitialConfig.js";
import { useCreateFailureActions } from "./hooks/useCreateFailureActions.js";
import { useTimelineProjection, type AskState, type PlanState, type QuestionState } from "./hooks/useTimelineProjection.js";
import { switchBlockedReason, type CreateFailure } from "./lib/switch-guards.js";
import { RuntimeTimeline } from "./components/RuntimeTimeline.js";
import { NavPlaceholderPage, type NavPage } from "./components/NavPages.js";
import { useQuotaActions } from "./hooks/useQuotaActions.js";
import { useDesktopNotifications } from "./hooks/useDesktopNotifications.js";
import { Onboarding } from "./components/Onboarding.js";
import "./styles.css";
import "./desktop-v2.css";
/**
 * kcode 桌面 renderer（M2b，§8.4h）：在 M2a 三栏之上补交互闭环——
 * 审批四档面板（N3I-5 参数级规则内联）、ask_user 结构化提问弹层、
 * 转写重放（reload 后 session/replay 恢复历史）、会话切换/续接（侧栏点击 → resume）。
 */
const styleEl = document.createElement("style");
styleEl.textContent = webCssTheme();
document.head.appendChild(styleEl);
const desktopStyleEl = document.createElement("style");
desktopStyleEl.textContent = desktopCssTheme();
document.head.appendChild(desktopStyleEl);
/** S1-5：经典 --z-* 主题（唯一来源 @kcode/design）——styles.css 不再自持调色板 */
const classicStyleEl = document.createElement("style");
classicStyleEl.textContent = desktopClassicTheme();
document.head.appendChild(classicStyleEl);
/** D3-UI 开关：默认启用；`?ui=classic` 或 localStorage 对应值可回退旧侧栏。 */
const UI_V2 =
  new URLSearchParams(window.location.search).get("ui") !== "classic" &&
  localStorage.getItem("kcode-desktop-ui-v2") !== "classic";
function DesktopApp() {
  const conn = useDesktopConnection();
  const panes = useWorkspacePanes(conn);
  const commands = useCommandCatalog(conn);
  const [timeline, setTimeline] = useState<TimelineState>(initialTimeline);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [modelDefault, setModelDefault] = useState<string | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [mode, setMode] = useState<PermissionMode>("default");
  const [queuedCount, setQueuedCount] = useState(0);
  const [ask, setAsk] = useState<AskState | null>(null);
  const [question, setQuestion] = useState<QuestionState | null>(null);
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [defaultCwd, setDefaultCwd] = useState("");
  /** 会话版本号：切换/续接时 +1——触发投影重置与重放 */
  const [sessionVersion, setSessionVersion] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const [appVersion, setAppVersion] = useState("dev");
  /** P0-2：创建/续接失败（非静默）——主区失败卡片的来源；会话成功建立后自动清除 */
  const [createFailure, setCreateFailure] = useState<CreateFailure | null>(null);
/** P1-2：sessions/changed 计数——此前在渲染路径里对全量事件数组 filter，流式期间每次重渲染都扫一遍 */
  const [sessionsSignal, setSessionsSignal] = useState(0);
  /** S1-8：一级导航（自动化/插件市场为静态占位页，F20/F21） */
  const [nav, setNav] = useState<NavPage>("chat");

  useEffect(() => {
    void window.kcodeHost?.getAppVersion().then(setAppVersion);
  }, []);

  // D1-07：标题 = 项目名（窗口标题随工作区变化）
  useEffect(() => {
    const name = defaultCwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "kcode";
    document.title = `${name} — kcode`;
  }, [defaultCwd]);

  // 系统通知（M3a）：仅在窗口失焦时发——任务完成 / 待审批（沿检测去重）
  useDesktopNotifications({ busy: timeline.busy, ask, plan });

  // 全局快捷键（capture；命令面板 / 新窗口 / 侧栏）
  const createdRef = useRef(false);
  const processed = useRef(0);
  const onNewSessionRef = useRef<(() => void) | null>(null);
  useGlobalShortcuts({ onNewSessionRef, setPaletteOpen, setSidebarCollapsed, openSettings: () => setSettingsOpen(true) });

  // 首帧配置（D1-01）：读完才进 onboarding/工作区；上次 cwd 优先
  useInitialConfig({ setModelDefault, setConfigLoaded, setDefaultCwd });

  // ready 即建会话（host 幂等——reload/StrictMode 重挂安全）。
  // attach/hello 存在短暂竞态，首轮 create 可能被拒；失败要重试，不能把 createdRef 永久卡死。
  useBootSession({ conn, modelDefault, defaultCwd, createdRef, setSessionId, setCreateFailure });

  // 转写重放（M2b）：会话就绪后拉一次全量事件重建时间线（reload/切换后续接都走这里）
  useSessionReplay({ conn, sessionId, sessionVersion, processed, setTimeline });

  // 事件流 → 投影（增量；弹层分流在 hook 内）
  useTimelineProjection({ conn, processed, setQueuedCount, setAsk, setQuestion, setPlan, setMode, setTimeline });

  // P1-2：增量计数 sessions/changed（事件数组只增；slice 从上次计数续扫，O(增量)）
  const signalSeen = useRef(0);
  useEffect(() => {
    const news = conn.events.slice(signalSeen.current);
    if (news.length === 0) return;
    signalSeen.current = conn.events.length;
    const count = news.filter((event) => event.type === "sessions/changed").length;
    if (count > 0) setSessionsSignal((value) => value + count);
  }, [conn.events]);

  const { onSend } = useDesktopCommands({
    conn,
    commands,
    mode,
    sessionId,
    modelDefault,
    queuedCount,
    onNewSessionRef,
    setMode,
    setTimeline,
  });

  const onStop = (): void => {
    void conn.send("session/interrupt").catch(() => undefined);
  };

  // P4-2（F16）：额度 banner 动作（重置额度/反馈）
  const { quotaReset, quotaFeedback } = useQuotaActions({ modelDefault, sessionId, openSettings: () => setSettingsOpen(true) });

  /** 时间线追加警告行（busy 拦截等提示共用） */
  const notify = useCallback((text: string): void => {
    setTimeline((prev) => ({
      ...prev,
      rows: [...prev.rows, { kind: "info" as const, text, tone: "warn" as const }],
    }));
  }, []);
  // 会话成功建立即清除失败卡片（重试成功路径）
  useEffect(() => {
    if (sessionId !== null) setCreateFailure(null);
  }, [sessionId]);
  /** 同窗口新建/续接会话；工作区路径由侧栏传入 */
  const { onNewSession, onResume } = useDesktopSessionSwitching({
    conn,
    modelDefault,
    defaultCwd,
    sessionId,
    busy: timeline.busy,
    notify,
    onFailure: setCreateFailure,
    setDefaultCwd,
    setSessionId,
    setSessionVersion,
    setQueuedCount,
    resetTimeline: () => setTimeline(initialTimeline()),
  });
  /** 切换工作区（D0-07）：选目录后统一走 onNewSession（P0-2/P0-3——同一护栏与失败恢复路径） */
  const onPickWorkspace = useCallback((): void => {
    if (timeline.busy) {
      notify(switchBlockedReason("workspace"));
      return;
    }
    void window.kcodeHost?.pickDirectory().then((dir) => {
      if (dir === null || dir === "" || dir === defaultCwd) return;
      localStorage.setItem("kcode-last-cwd", dir);
      // 尚无会话/模型时只记住目录；否则 dispose→create 走统一切换链路
      if (sessionId === null || modelDefault === null) {
        setDefaultCwd(dir);
        return;
      }
      onNewSession(dir);
    });
  }, [defaultCwd, modelDefault, notify, onNewSession, sessionId, timeline.busy]);
  const ready = conn.status === "ready" && sessionId !== null;
  // P0-2：失败卡片动作（重试复用同一 requestId / 恢复上一个任务）
  const { retryCreate, resumePreviousSession } = useCreateFailureActions({ createFailure, onNewSession, onResume });
  const trust = useWorkspaceTrust(conn, defaultCwd);
  const modelPicker = useModelPicker({ conn, model: modelDefault, setModel: setModelDefault, notify });
  const contextStats = useSessionContext(conn, sessionId, timeline.busy);
  const projectName = defaultCwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "kcode";
  onNewSessionRef.current = onNewSession;
  const isEmpty = ready && timeline.rows.length === 0 && timeline.streamText === "";
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
  if (!configLoaded) {
    return <div className="center-note">正在读取配置…</div>;
  }
  if (modelDefault === null) {
    return conn.status === "ready" ? (
      <Onboarding
        conn={conn}
        initialCwd={defaultCwd}
        onComplete={(modelRef, cwd) => {
          localStorage.setItem("kcode-last-cwd", cwd);
          setDefaultCwd(cwd);
          setModelDefault(modelRef);
        }}
      />
    ) : (
      <div className="center-note">正在连接宿主进程…</div>
    );
  }

  return (
    <>
      <WorkspaceLayout
      collapsed={sidebarCollapsed}
      onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
      sidePane={panes.sidePane}
      sidePaneOpen={panes.sidePaneOpen}
      onCloseSidePane={panes.close}
      sidebar={
        UI_V2 ? (
          <DesktopSidebar
            conn={conn}
            currentId={sessionId}
            currentWorkspace={defaultCwd}
            currentPreview={timeline.rows.find((row) => row.kind === "user")?.text ?? ""}
            activityKey={timeline.rows.length}
            sessionsSignal={sessionsSignal}
            onOpen={onResume}
            onNewSession={onNewSession}
            onOpenSettings={() => setSettingsOpen(true)}
            nav={nav}
            onNavChange={setNav}
          />
        ) : (
          <SessionSidebar
            conn={conn}
            currentId={sessionId}
            workspace={defaultCwd}
            onOpen={onResume}
            onNewSession={onNewSession}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )
      }
      main={nav === "chat" ? (
        <div className={`main-column ${isEmpty ? "draft" : ""}`}>
          <WorkspaceHeader
            title={projectName}
            cwd={defaultCwd}
            model={modelDefault}
            mode={mode}
            onPickWorkspace={onPickWorkspace}
            onShowChanges={panes.openChanges}
            onShowTasks={panes.openTasks}
          />
          <div className="timeline-stack">
            {trust.visible ? (
              <TrustBanner onTrust={() => void trust.trust()} onDismiss={trust.dismiss} />
            ) : null}
              {createFailure !== null ? (
                <CreateFailureCard
                  failure={createFailure}
                  onRetry={retryCreate}
                  onResumePrevious={resumePreviousSession}
                />
              ) : null}
              <RuntimeTimeline
                timeline={timeline}
                model={modelDefault}
                onOpenDiff={panes.openDiff}
                onQuotaReset={quotaReset}
                onQuotaFeedback={quotaFeedback}
                onRetryFailed={onSend}
                onContinue={() => onSend("继续")}
              />
              {isEmpty ? (
                <EmptyState cwd={defaultCwd} onPick={(text) => setPrefill({ text, nonce: Date.now() })} />
              ) : null}
            {ask !== null ? (
              <AskPanel
                tool={ask.tool}
                args={ask.args}
                {...(ask.preview !== undefined ? { preview: ask.preview } : {})}
                onRespond={(allowed, scope) => {
                  setAsk(null);
                  void conn.send("ask/respond", { requestId: ask.requestId, allowed, scope }).catch(() => undefined);
                }}
              />
            ) : null}
            {plan !== null ? (
              <PlanPanel
                plan={plan.plan}
                onRespond={(verdict) => {
                  setPlan(null);
                  void conn.send("plan/respond", { requestId: plan.requestId, verdict }).catch(() => undefined);
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
            inputDisabled={conn.status !== "ready"}
            queuedCount={queuedCount}
            mode={mode}
            model={modelDefault}
            context={contextStats}
            prefill={prefill}
            commands={commands}
            onListModels={modelPicker.listModels}
            onModelChange={modelPicker.changeModel}
            onListFiles={async (query) => {
              const r = (await conn.send("session/files", { query }).catch(() => null)) as { files?: string[] } | null;
              return r?.files ?? [];
            }}
            onModeChange={(m) => {
              setMode(m);
              void conn.send("session/set_mode", { mode: m }).catch(() => undefined);
            }}
            onSend={onSend}
            onStop={onStop}
            onPickImages={() => window.kcodeHost?.pickImages() ?? Promise.resolve([])}
          />
        </div>
      ) : (
        <NavPlaceholderPage page={nav} onBack={() => setNav("chat")} />
      )}
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
      {settingsOpen ? (
        <SettingsPage
          conn={conn}
          onClose={() => setSettingsOpen(false)}
          appVersion={appVersion}
          model={modelDefault}
          cwd={defaultCwd}
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

import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import type {
  PermissionMode,
} from "@kcode/contracts";
import { bootstrap, type Runtime } from "../bootstrap.js";
import { createSession, type SessionHandle } from "../session.js";
import { appendHistory, saveInputHistory } from "../history-store.js";
import { ServicesProvider, createUiStore, type Block } from "@kcode/ui";
import { platformClientAdapter } from "@kcode/contracts";
import { c } from "./theme/theme.js";
import { MODE_META } from "./theme/modes.js";
import { appendInputLog } from "./terminal/input-log.js";
import { useKeybinds } from "./terminal/keybinds.js";
import { useInputListenerLimit } from "./terminal/input-limit.js";
import { useTerminalTitle } from "./terminal/title.js";
import { useAttentionBell, useCompletionBell } from "./terminal/notify.js";
import { useSessionLifecycle } from "./state/lifecycle.js";
import { InputArea } from "./input/InputArea.js";
import { runDispatch } from "./input/commands.js";
import { DialogLayer } from "./dialogs/DialogLayer.js";
import { createSandboxPort, sandboxSetting, startSandboxPty, type SandboxPtySession } from "@kcode/sandbox";
import type { RewindPoint } from "./dialogs/panels.js";
import { StatusLine, StatusBar } from "./status/StatusLine.js";
import { TranscriptView } from "./transcript/TranscriptView.js";
import { createStreamController } from "./state/stream.js";
import { makeEventHandler } from "./state/events.js";
import { useStatusStats, useBackgroundTasks } from "./state/status-data.js";
import { makeInteractions, type AskState, type DiffBrowserState, type QuestionState, type PlanApprovalState } from "./state/interactions.js";
import { BUILTIN_COMMANDS, type CommandInfo } from "./input/builtin-commands.js";
import type { MenuOption } from "./dialogs/OptionsMenu.js";
import { filterChanges } from "./dialogs/diff-model.js";
import { stripEscapes } from "./terminal/sanitize.js";

export interface KcodeAppProps {
  /** 运行时（配置/keychain/providers 路由）：引擎内嵌本进程组装（C 级单进程化） */
  runtime: Runtime;
  model: string;
  cwd: string;
  /** 一次性提问（非交互/脚本模式）；缺省进 REPL */
  oneShot?: string;
  /** 一次性提问附图（本地文件路径，多模态输入） */
  images?: string[];
  /** 续接来源（会话 id / 前缀 / latest，本地从 JSONL 解析重建） */
  resumeFrom?: string;
  /** 独立验收入口可指定输入历史，避免混入日常会话。 */
  historyFile?: string;
  /** 项目配置的默认权限档（2-06；fullAccess 不会从这里进入） */
  initialMode?: PermissionMode;
  /** 组装期剔除的工具（2-10：与 headless 同一路径，未知名在 compose 期抛错） */
  disallowedTools?: string[];
  /** `kcode login`：启动即打开登录向导 */
  initialLogin?: boolean;
}


import type { LoginWizard } from "./dialogs/wizard-state.js";

/** /model 选择菜单状态 */
type ModelPicker = null | { options: MenuOption[] };







/** 2-05：fatal 驻留屏——错误与修复命令可读，r 重试 / q 退出 */
function FatalScreen(props: { message: string }) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text color={c("destructive")}>✗ {props.message}</Text>
      <Text dimColor>按 r 重试 · q 退出</Text>
    </Box>
  );
}

/** kcode 主界面：流式输出、工具状态、菜单式确认（diff 预览）、Todo 面板、结构化提问、四档权限模式 */
export function KcodeApp(props: KcodeAppProps) {
  useInputListenerLimit();
  const { exit } = useApp();
  /** UI 语义 store（N2-3）：运行状态 + 转写双 slice；同步判定走 getState（store 即时生效，无闭包过期） */
  const ui = useRef(createUiStore()).current;
  const blocks = ui((state) => state.blocks);
  const streamText = ui((state) => state.streamText);
  const notice = ui((state) => state.notice);
  const busy = ui((state) => state.busy);
  const queuedCount = ui((state) => state.queuedCount);
  const busySince = ui((state) => state.busySince);
  const reasoningText = ui((state) => state.reasoningText);
  const runPhase = ui((state) => state.phase);
  const pendingTools = ui((state) => state.pendingTools);
  const cancelling = ui((state) => state.cancelling);
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [ask, setAsk] = useState<AskState | null>(null);
  const [question, setQuestion] = useState<QuestionState | null>(null);
  const [mode, setMode] = useState<PermissionMode>(props.initialMode ?? "default");
  const [modelLabel, setModelLabel] = useState(props.model === "" ? "未配置" : props.model);
  const [fullAccessConfirm, setFullAccessConfirm] = useState(false);
  /** /terminal：优先 MXC 受保护 PTY；srt 不支持交互 stdin，回退普通 PTY 并明示 */
  const [terminal, setTerminal] = useState<{ session: SandboxPtySession; title: string; protectedMode: boolean } | null>(null);
  /** /permissions 面板：当前项目持久放行清单与清空确认 */
  const [permissionsPanel, setPermissionsPanel] = useState<string[] | null>(null);
  /** /resume 会话选择菜单：选项与会话 id 对齐（末位为取消） */
  const [resumePicker, setResumePicker] = useState<{ options: MenuOption[]; ids: string[] } | null>(null);
  /** /rewind 回退点选择菜单（/rewind 命令或空闲双击 Esc 打开） */
  const [rewindPicker, setRewindPicker] = useState<RewindPoint[] | null>(null);
  /** 3-23 /diff 审查面板（改动清单 + 单文件 hunk + 逐文件回退） */
  const [diffBrowser, setDiffBrowser] = useState<DiffBrowserState | null>(null);
  /** 计划批准面板（plan_submit 工具推送）：渲染计划全文 + 批准菜单 */
  const [planApproval, setPlanApproval] = useState<PlanApprovalState | null>(null);
  const [input, setInput] = useState("");
  const [modelPicker, setModelPicker] = useState<ModelPicker>(null);
  const [loginWizard, setLoginWizard] = useState<LoginWizard>(
    props.initialLogin
      ? {
          stage: "method",
          providerName: "",
          presetBaseURL: "",
          presetModel: "",
          baseURL: "",
          apiKey: "",
          model: "",
        }
      : null,
  );
  const [commands, setCommands] = useState<CommandInfo[]>(BUILTIN_COMMANDS);
  /** IME 上屏强制重绘：终端清除组合区覆盖的时机在应用渲染之后（日志实测 0~1.3s 窗口），
   *  0~1.5s 五连重绘覆盖；交替空格保证每次帧都有 diff 绕过 Ink 去重 */
  const [repaintTick, setRepaintTick] = useState(0);
  const pingRepaint = (): void => {
    setRepaintTick((t) => t + 1);
    // 两拍即可（CJK 扁平渲染修复后提交帧本身正确；多拍反而造成底部闪动）
    setTimeout(() => setRepaintTick((t) => t + 1), 400);
  };
  useEffect(() => {
    if (process.env["KCODE_INPUT_DEBUG"] === "1" && repaintTick > 0) {
      try {
        appendInputLog(`repaint tick=${repaintTick}`);
      } catch {}
    }
  }, [repaintTick]);
  /** 转写展开态（Ctrl+O 切换）：思考全文 / 工具输出多行 */
  const [verbose, setVerbose] = useState(false);
  /** 驱动 running 态动态耗时与 busy 计时的时钟（250ms 一拍） */
  const [tick, setTick] = useState(Date.now());
  const sessionRef = useRef<Awaited<ReturnType<typeof createSession>> | null>(null);
  const inputHistory = useRef<string[]>([]);
  const { stdin } = useStdin();
  // ink-testing-library 的假 stdin 只有 isTTY、没有 ref；真终端两者都有
  const interactive = stdin.isTTY === true && typeof (stdin as { ref?: unknown }).ref === "function";
  const stream = useRef(createStreamController(ui)).current;
  // 状态栏常驻数据（N3C-4①）：用量订阅 + busy 收尾沿刷新 + git 分支低频采样
  const { usage, branch } = useStatusStats(ui, sessionRef, busy, ready, props.cwd);
  // 3-27：后台任务快照（状态栏 ⚙ N / Ctrl+T 面板共用）；完成沿响铃
  const backgroundTasks = ui((s) => s.backgroundTasks);
  useBackgroundTasks(ui, sessionRef, ready);
  const runningTasks = backgroundTasks.filter((t) => t.status === "running").length;

  // 时钟只在有动态内容时运行（busy/运行中工具/流式文本）——
  // 空闲时持续重渲染会在部分终端（conhost/管道输出）造成帧堆积刷屏
  const active =
    busy ||
    reasoningText !== "" ||
    streamText !== "" ||
    blocks.some((b) => b.kind === "tool" && b.status === "running");
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => {
      setTick(Date.now());
      // 思考增量合帧刷显：reasoning delta 量大，逐条入 store 会拖垮 Ink 渲染
      stream.syncReasoningDisplay();
    }, 250);
    return () => clearInterval(timer);
  }, [active]);

  // Ctrl+O：折叠 ⇄ 展开转写（对标 Claude Code 的 transcript 切换）。
  // 3-25：Static 里的旧块不会自动重绘——清屏/清 scrollback 后递增 renderEpoch，
  // 由 TranscriptView 以新展开度重放全部定稿块（否则 Ctrl+O 对已滚出屏幕的块毫无效果）。
  useInput(
    (ch, key) => {
      if (key.ctrl && ch.toLowerCase() === "o" && fatal === null) {
        process.stdout.write("\x1b[3J\x1b[2J\x1b[H");
        setVerbose((v) => !v);
        ui.getState().replayTranscript();
      }
    },
    { isActive: interactive },
  );

  /** 本轮已发送过中断（重复按 Esc/Ctrl+C 不再刷提示，等当前命令退出） */
  const abortSent = useRef(false);
  /** 退出幂等：Ctrl+C 双击/exit/exit 排队可能并发触发 */
  const shuttingDown = useRef(false);
  const interactions = useRef(
    makeInteractions({ ui, interactive, abortSent, setAsk, setQuestion, setPlanApproval }),
  ).current;
  const { asker, askUser, onPlanApproval } = interactions;
  const beginWork = (): void => {
    abortSent.current = false;
    ui.getState().begin();
  };
  useEffect(() => {
    if (!busy) {
      const status = ui.getState();
      status.setCancelling(false);
      if (status.notice === "正在取消，等待当前操作退出…") {
        status.setNotice(null);
      }
    }
  }, [busy]);

  /** 中断当前运行：发送 abort，并立即收掉挂起的交互 */
  const interruptRun = (): void => {
    if (!busy) {
      return;
    }
    if (abortSent.current) {
      return; // 已请求过：正在等待当前命令被终止
    }
    abortSent.current = true;
    ui.getState().setCancelling(true);
    ui.getState().setNotice("正在取消，等待当前操作退出…");
    // N2-2/3-33：中断不静默清空队列——暂停待执行项，由 /queue run|clear 显式处理
    const queued = sessionRef.current?.commandQueue.size ?? 0;
    if (queued > 0) {
      ui.getState().setQueuePaused(true);
      pushBlock({
        kind: "info",
        tone: "warn",
        text: `⎋ 已中断本轮；队列保留 ${queued} 条（/queue run 继续 · /queue clear 清空）`,
      });
    }
    // 先发取消，再结算本地交互，避免拒绝回复先到达后触发下一次模型调用。
    sessionRef.current?.abort();
    if (ask !== null) {
      ask.resolve({ allowed: false });
      setAsk(null);
      pushBlock({ kind: "info", tone: "deny", text: `❯ 拒绝 · ${ask.call.tool}（随中断）` });
    }
    if (question !== null) {
      question.resolve([]);
      setQuestion(null);
      pushBlock({ kind: "info", text: "→ 已选：（随中断取消）" });
    }
    if (planApproval !== null) {
      planApproval.reply([]);
      setPlanApproval(null);
    }
    pushBlock({ kind: "info", tone: "warn", text: "⎋ 已请求中断当前运行…" });
  };

  const menuOccupied =
    ask !== null ||
    question !== null ||
    fullAccessConfirm ||
    modelPicker !== null ||
    loginWizard !== null ||
    permissionsPanel !== null ||
    resumePicker !== null ||
    rewindPicker !== null ||
    diffBrowser !== null ||
    planApproval !== null ||
    terminal !== null;

  /** /rewind：取回退点并打开选择菜单（空闲时才可用） */
  const openRewindPicker = (): void => {
    if (ui.getState().busy) {
      pushBlock({ kind: "info", tone: "warn", text: "运行中不能回退（等本轮完成或 Esc 中断）" });
      return;
    }
    void (async () => {
      const session = sessionRef.current;
      if (session === null) return;
      const points = await session.rewindPoints().catch(() => null);
      if (points === null) {
        pushBlock({ kind: "info", tone: "warn", text: "回退点获取失败（会话操作异常）" });
        return;
      }
      if (points.length === 0) {
        pushBlock({ kind: "info", text: "（暂无可回退的提问点——本会话还没有用户消息或文件改动）" });
        return;
      }
      setRewindPicker(points.slice(-10).reverse());
    })();
  };

  /**
   * 3-23 `/diff`：读检查点改动清单并打开审查面板。
   * 运行中拒绝——回退与写类工具并发会半回滚；筛选词保留在面板状态里，回退后按同词刷新。
   */
  const openDiffBrowser = (query?: string): void => {
    if (ui.getState().busy) {
      pushBlock({ kind: "info", tone: "warn", text: "运行中不能审查/回退文件改动（等本轮完成或 Esc 中断）" });
      return;
    }
    const session = sessionRef.current;
    if (session === null) return;
    void (async () => {
      const changes = await session.listChanges().catch(() => null);
      if (changes === null) {
        pushBlock({ kind: "info", tone: "warn", text: "改动清单获取失败（会话操作异常）" });
        return;
      }
      const filtered = filterChanges(changes, query ?? "", props.cwd);
      if (filtered.length === 0) {
        pushBlock({
          kind: "info",
          text:
            query !== undefined
              ? `（没有匹配「${query}」的改动文件；/diff 查看全部改动）`
              : "（本会话没有可审查的文件改动——write/edit/apply_patch 会留检查点；bash 直接改文件不追踪）",
        });
        return;
      }
      setDiffBrowser({
        changes: filtered,
        ...(query !== undefined ? { query } : {}),
        // 精确筛选到唯一文件时直奔 hunk 视图，少一次回车
        ...(query !== undefined && filtered.length === 1 ? { focusPath: filtered[0]!.path } : {}),
      });
    })();
  };

  /** 3-23：回退单个文件（复用检查点前像），再按当前筛选词刷新 /diff 清单 */
  const revertFile = async (path: string): Promise<{ remaining: number } | string> => {
    const session = sessionRef.current;
    if (session === null) return "会话未就绪";
    if (ui.getState().busy) return "运行中不能回退文件（等本轮完成或 Esc 中断）";
    try {
      await session.revertChanges([path]);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    const query = diffBrowser?.query;
    const changes = await session.listChanges().catch(() => null);
    if (changes === null) {
      setDiffBrowser(null);
      return "回退已完成，但改动清单刷新失败（会话操作异常）";
    }
    const filtered = filterChanges(changes, query ?? "", props.cwd);
    setDiffBrowser(filtered.length === 0 ? null : { changes: filtered, ...(query !== undefined ? { query } : {}) });
    return { remaining: filtered.length };
  };

  const pushBlock = (block: Block): void => {
    ui.getState().pushBlock(block);
  };

  /** 把流式缓冲定格为完成块（工具调用开始或轮次完成时）；思考折叠为单行摘要 */
  const suppressNextUserBlock = useRef(false);
  const handleEvent = useRef(makeEventHandler({ ui, stream, suppressNextUserBlock })).current;

  /** 应用模式切换：本地状态 + 引擎换档 */
  const applyMode = (next: PermissionMode): void => {
    setMode(next);
    sessionRef.current?.setMode(next);
    pushBlock({ kind: "info", text: `⇄ 已切换：${MODE_META[next].label}（${MODE_META[next].hint}）` });
  };

  /** 3-36：命令面板的“切换权限模式”动作（与 Shift+Tab 同一循环，fullAccess 仍走显式确认） */
  const cycleMode = (): void => {
    const order: PermissionMode[] = ["plan", "default", "acceptEdits"];
    const index = order.indexOf(mode);
    applyMode(order[(index + 1) % order.length] ?? "default");
  };

  /**
   * 退出：先关会话（停后台 bash/子代理、等当前 run 结算、关 MCP），再卸载 Ink。
   * close 内部有 2s 上限；不能让 exit() 先发生，否则子进程/会话文件尾部会丢。
   */
  const shutdown = (): void => {
    if (shuttingDown.current) return;
    shuttingDown.current = true;
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session === null) {
      exit();
      return;
    }
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_500);
      timer.unref?.();
    });
    void Promise.race([session.close().catch(() => undefined), timeout]).finally(() => exit());
  };

  // 3-03：外部 SIGINT/SIGTERM（kill、IDE 停止、CI 超时）也走 close：
  // 停后台 bash/子代理/MCP，给 runner 3.5s 收尾，再强制退出。
  useEffect(() => {
    const onSignal = (): void => {
      shutdown();
      const timer = setTimeout(() => process.exit(143), 3_500);
      timer.unref?.();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    return () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 2-05：fatal 后重试初始会话装配 */
  const retryFatal = (): void => {
    setFatal(null);
    setReady(false);
    setRetryToken((n) => n + 1);
  };

  // 全局按键绑定（Esc/Shift+Tab/Ctrl+C/Ctrl+B，N2-3 外迁 terminal/keybinds.ts）
  useKeybinds({
    busy,
    interactive,
    menuOccupied,
    inputEmpty: input === "",
    hasSession: sessionRef.current !== null,
    mode,
    ui,
    interruptRun,
    openRewindPicker,
    applyMode,
    exit: shutdown,
    stopTask: (id: string) => {
      const ok = sessionRef.current?.stopBackgroundTask(id) ?? false;
      pushBlock({
        kind: "info",
        tone: ok ? "ok" : "warn",
        text: ok ? `■ 已停止后台任务 ${id}` : `✗ 任务 ${id} 未在运行或已结束`,
      });
    },
    pushBlock: (block) => ui.getState().pushBlock(block),
    fatal,
    retryFatal,
  });

  // 会话生命周期（初始装配 + /resume 换建，N2-3 外迁 state/lifecycle.ts）
  const { switchSession } = useSessionLifecycle({
    props,
    ui,
    stream,
    createSession,
    sessionRef,
    inputHistory,
    handleEvent,
    asker,
    askUser,
    onPlanApproval,
    beginWork,
    setReady,
    setFatal,
    setCommands,
    pushBlock: (block) => ui.getState().pushBlock(block),
    modelLabel,
    mode,
    exit: shutdown,
    retryToken,
  });

  /** N2-2：本轮结束即取下一条排队输入递归执行；队列空则停（3-33：暂停态不自动续跑） */
  const drainQueue = async (): Promise<void> => {
    if (ui.getState().queuePaused) {
      return;
    }
    const next = sessionRef.current?.commandQueue.dequeue();
    if (next !== undefined) {
      await dispatch(next.text);
    }
  };

  /** 3-33：/queue run——恢复队列；空闲时立即开始排空 */
  const resumeQueue = (): void => {
    ui.getState().setQueuePaused(false);
    if (!ui.getState().busy && sessionRef.current !== null) {
      void drainQueue();
    }
  };

  /**
   * N2-2 占位执行：reservation 拿不到（双 turn 竞态）则入队而非抛错；
   * 完成/中断释放并排空。四个占引擎的路径（!命令 / /skill / 自定义命令 / 纯文本）共用。
   */
  const runOccupied = async (session: SessionHandle, text: string, work: () => Promise<unknown>): Promise<void> => {
    if (!session.commandQueue.tryReserve()) {
      session.commandQueue.enqueue(text);
      return;
    }
    beginWork();
    try {
      await work();
    } catch (err) {
      pushBlock({ kind: "info", tone: "warn", text: `✗ ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      session.commandQueue.release();
      ui.getState().finish();
      void drainQueue();
    }
  };

  /** 输入提交：运行中入队（N2-2，不带附件），空闲直接分发（携带图片附件 N3C-4⑤） */
  const submit = async (value: string, images?: string[]): Promise<void> => {
    const text = value.trim();
    if (text === "" || sessionRef.current === null) return;
    if (text === "exit" || text === "quit") {
      shutdown();
      return;
    }
    if (ui.getState().busy) {
      // 3-33：/queue 管理命令在运行中即时执行（其余输入才排队；否则清空/删除队列无从操作）
      if (/^\/queue(?:\s|$)/i.test(text)) {
        setInput("");
        await dispatch(text);
        return;
      }
      const session = sessionRef.current;
      session.commandQueue.enqueue(text);
      setInput("");
      saveHistory(text);
      return;
    }
    // 守卫全部通过才清附件：exit/空输入不应丢掉已贴的图
    ui.getState().clearPendingImages();
    await dispatch(text, images);
  };

  /** 记录输入历史（截断 50 条并持久化） */
  const saveHistory = (text: string): void => {
    inputHistory.current = appendHistory(inputHistory.current, text).slice(-50);
    void saveInputHistory(inputHistory.current, props.historyFile);
  };

  /** /terminal：MXC 可用时使用受保护 PTY；srt 明确回退普通 PTY。 */
  const startTerminal = async (): Promise<void> => {
    if (terminal !== null) return;
    if (process.env["KCODE_ACCESS_MODE"] === "read-only") {
      pushBlock({ kind: "info", tone: "warn", text: "访问模式 read-only：禁止打开交互终端" });
      return;
    }
    try {
      const setting = sandboxSetting();
      let backend: "mxc" | "plain" = "plain";
      let warning = "";
      if (setting !== "off") {
        const status = await createSandboxPort()?.available();
        if (status?.available === true && status.backend === "mxc") {
          backend = "mxc";
        } else if (setting === "mxc") {
          throw new Error(`MXC 不可用：${status?.reason ?? "unknown"}`);
        } else if (status?.backend === "srt") {
          warning = "srt Windows exec 不支持交互 stdin；/terminal 以普通 PTY 启动，不受 srt 保护。";
        }
      }
      const windows = process.platform === "win32";
      const session = await startSandboxPty({
        backend,
        cwd: props.cwd,
        shellFile: windows ? "powershell.exe" : "bash",
        shellName: windows ? "powershell" : "bash",
        mode: "workspace-write",
        cols: process.stdout.columns ?? 100,
        rows: process.stdout.rows ?? 30,
        env: process.env,
      });
      if (warning !== "") pushBlock({ kind: "info", tone: "warn", text: warning });
      setTerminal({ session, title: backend === "mxc" ? "MXC" : "PTY", protectedMode: backend === "mxc" });
    } catch (err) {
      pushBlock({
        kind: "info",
        tone: "warn",
        text: `PTY 启动失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  /** 分发一条输入（submit 直达或排空递归）：解析与执行在 input/commands.ts（N2-3 外迁） */
  const dispatch = async (text: string, images?: string[]): Promise<void> => {
    const session = sessionRef.current;
    if (session === null) return;
    await runDispatch(
      {
        session,
        sessionRef,
        props,
        ui,
        modelLabel,
        mode,
        inputHistory,
        suppressNextUserBlock,
        pushBlock,
        setInput,
        setModelLabel,
        applyMode,
        setFullAccessConfirm,
        setModelPicker,
        setLoginWizard,
        setResumePicker,
        setPermissionsPanel,
        switchSession,
        openRewindPicker,
        openDiffBrowser,
        runOccupied,
        saveHistory,
        beginWork,
        resetAbortSent: () => { abortSent.current = false; },
        exitApp: shutdown,
        createSession,
        handleEvent,
        appendDelta: stream.appendDelta,
        appendReasoning: stream.appendReasoning,
        asker,
        askUser,
        onPlanApproval,
        onQueueChange: (items) => ui.getState().setQueuedItems(items.map((item) => ({ ...item }))),
        resumeQueue,
        startTerminal,
      },
      text,
      images,
    );
  };

  // N3F-2/3：标题栏进度 + 完成铃（逻辑全在 tui/terminal 模块，App 只挂一行——行数红线）。
  // activityLabel 上移到 early return 之前：hook 不能落在条件返回之后
  const toolNames = Object.values(pendingTools);
  // tool_call 表示模型提出调用，尚不保证已获准执行，因此使用“处理工具”。
  const activityLabel = cancelling ? "正在取消，等待当前操作退出"
    : ask !== null ? `等待工具确认：${ask.call.tool}`
    : planApproval !== null ? "等待计划批准"
    : question !== null ? "等待你的回答"
    : toolNames.length > 0 ? `处理工具：${[...new Set(toolNames)].join("、")}`
    : runPhase;
  const attention = ask !== null || planApproval !== null || question !== null;
  useTerminalTitle(busy, activityLabel, attention);
  useAttentionBell(attention);
  useCompletionBell(busy, busySince);

  if (fatal !== null) {
    return <FatalScreen message={fatal} />;
  }

  /**
   * 2-01：/login 保存后热生效——重读配置/keychain，原地更新同一个 Runtime 对象，
   * 再让当前会话 setModel。既有 session 的 llmFactory 每次调用都查 runtime.router，
   * 因此不需要重启进程或重建会话。
   */
  const reloadRuntime = async (model: string): Promise<string | null> => {
    try {
      const next = await bootstrap({ settingsPath: props.runtime.configPath });
      Object.assign(props.runtime, next);
      const err = (await sessionRef.current?.setModel(model)) ?? null;
      if (err === null) {
        setModelLabel(model);
        pushBlock({ kind: "info", tone: "ok", text: `✓ 配置已生效：${model}（无需重启）` });
      }
      return err;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  const meta = MODE_META[mode];
  const busyElapsed =
    busy && busySince !== null && tick > busySince ? ` (${((tick - busySince) / 1000).toFixed(1)}s)` : "";

  return (
    <ServicesProvider
      services={{
        // N3-2 注 E：前端只拿 PlatformClientPort（probe/saveKey），完整实现留在宿主侧
        platform: platformClientAdapter(props.runtime.platform),
        ui,
        configPath: props.runtime.configPath,
        getSession: () => sessionRef.current,
        dialogs: {
          setMode,
          applyMode,
          switchSession,
          rewind: (eventIndex: number) =>
            sessionRef.current?.rewind(eventIndex) ?? Promise.resolve("会话未就绪"),
          // 3-23 /diff：逐文件回退（复用检查点前像），失败以字符串返回给面板展示
          revertFile,
          setModel: async (ref: string) => {
            try {
              await sessionRef.current?.setModel(ref);
              return null;
            } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          },
          setModelLabel,
          reloadRuntime,
          clearPersistentGrants: async () => {
            await sessionRef.current?.clearPersistentGrants();
            return true;
          },
          pushBlock,
          setAsk,
          setQuestion,
          setPlanApproval,
          setRewindPicker,
          setDiffBrowser,
          setResumePicker,
          setPermissionsPanel,
          setFullAccessConfirm,
          setLoginWizard,
          setModelPicker,
        },
      }}
    >
      <Box flexDirection="column" width="100%">
        <TranscriptView ui={ui} verbose={verbose} tick={tick} />
        {notice !== null && (
          <Text color={c("warning")} wrap="truncate-end">
            {stripEscapes(notice)}
          </Text>
        )}
        {busy && (
          <StatusLine
            label={activityLabel}
            elapsed={busyElapsed}
            verbose={verbose}
            queuedCount={queuedCount}
            toolNames={Object.values(pendingTools)}
          />
        )}
        <DialogLayer
          ask={ask}
          question={question}
          planApproval={planApproval}
          rewindPicker={rewindPicker}
          diffBrowser={diffBrowser}
          cwd={props.cwd}
          resumePicker={resumePicker}
          permissionsPanel={permissionsPanel}
          fullAccessConfirm={fullAccessConfirm}
          loginWizard={loginWizard}
          modelPicker={modelPicker}
          terminal={terminal}
          onCloseTerminal={() => {
            terminal?.session.kill();
            setTerminal(null);
          }}        >
          {/* N2-2：输入区常驻——busy 中提交进入排队而非丢弃；N3C-4②：浏览器打开时被顶替 */}
          <InputArea
            ui={ui}
            ready={ready}
            interactive={interactive}
            value={input}
            onChange={setInput}
            onSubmit={(v) => void submit(v)}
            history={inputHistory.current}
            commands={commands}
            cwd={props.cwd}
            {...(sessionRef.current?.jsonlPath !== undefined ? { jsonlPath: sessionRef.current.jsonlPath } : {})}
            loadToolOutput={(callId) => sessionRef.current?.toolResultOutput?.(callId) ?? Promise.resolve(null)}
            onCjkCommit={pingRepaint}
            onCycleMode={cycleMode}
            onInterrupt={interruptRun}
          />
        </DialogLayer>
        <StatusBar
          mode={mode}
          modelLabel={modelLabel}
          verbose={verbose}
          repaintTick={repaintTick}
          busy={busy}
          usage={usage}
          branch={branch}
          runningTasks={runningTasks}
        />
      </Box>
    </ServicesProvider>
  );
}

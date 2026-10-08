import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import type {
  PermissionMode,
} from "@kcode/contracts";
import type { Runtime } from "../bootstrap.js";
import { createSession, type SessionHandle } from "../session.js";
import { appendHistory, saveInputHistory } from "../history-store.js";
import { ServicesProvider, createUiStore, type Block } from "@kcode/ui";
import { platformClientAdapter } from "@kcode/contracts";
import { c } from "./theme/theme.js";
import { MODE_META } from "./theme/modes.js";
import { appendInputLog } from "./terminal/input-log.js";
import { useKeybinds } from "./terminal/keybinds.js";
import { useTerminalTitle } from "./terminal/title.js";
import { useCompletionBell } from "./terminal/notify.js";
import { useSessionLifecycle } from "./state/lifecycle.js";
import { InputArea } from "./input/InputArea.js";
import { runDispatch } from "./input/commands.js";
import { DialogLayer } from "./dialogs/DialogLayer.js";
import type { RewindPoint } from "./dialogs/panels.js";
import { StatusLine, StatusBar } from "./status/StatusLine.js";
import { TranscriptView } from "./transcript/TranscriptView.js";
import { createStreamController } from "./state/stream.js";
import { makeEventHandler } from "./state/events.js";
import { useStatusStats } from "./state/status-data.js";
import { makeInteractions, type AskState, type QuestionState, type PlanApprovalState } from "./state/interactions.js";
import { BUILTIN_COMMANDS, type CommandInfo } from "./input/builtin-commands.js";
import type { MenuOption } from "./dialogs/OptionsMenu.js";

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
}


import type { LoginWizard } from "./dialogs/wizard-state.js";

/** /model 选择菜单状态 */
type ModelPicker = null | { options: MenuOption[] };







/** kcode 主界面：流式输出、工具状态、菜单式确认（diff 预览）、Todo 面板、结构化提问、四档权限模式 */
export function KcodeApp(props: KcodeAppProps) {
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
  const [ask, setAsk] = useState<AskState | null>(null);
  const [question, setQuestion] = useState<QuestionState | null>(null);
  const [mode, setMode] = useState<PermissionMode>("default");
  const [modelLabel, setModelLabel] = useState(props.model);
  const [fullAccessConfirm, setFullAccessConfirm] = useState(false);
  /** /permissions 面板：当前项目持久放行清单与清空确认 */
  const [permissionsPanel, setPermissionsPanel] = useState<string[] | null>(null);
  /** /resume 会话选择菜单：选项与会话 id 对齐（末位为取消） */
  const [resumePicker, setResumePicker] = useState<{ options: MenuOption[]; ids: string[] } | null>(null);
  /** /rewind 回退点选择菜单（/rewind 命令或空闲双击 Esc 打开） */
  const [rewindPicker, setRewindPicker] = useState<RewindPoint[] | null>(null);
  /** 计划批准面板（plan_submit 工具推送）：渲染计划全文 + 批准菜单 */
  const [planApproval, setPlanApproval] = useState<PlanApprovalState | null>(null);
  const [input, setInput] = useState("");
  const [modelPicker, setModelPicker] = useState<ModelPicker>(null);
  const [loginWizard, setLoginWizard] = useState<LoginWizard>(null);
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
  const interactive = stdin.isTTY === true;
  const stream = useRef(createStreamController(ui)).current;
  // 状态栏常驻数据（N3C-4①）：用量订阅 + busy 收尾沿刷新 + git 分支低频采样
  const { usage, branch } = useStatusStats(ui, sessionRef, busy, ready, props.cwd);

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

  // Ctrl+O：折叠 ⇄ 展开转写（对标 Claude Code 的 transcript 切换）
  useInput(
    (ch, key) => {
      if (key.ctrl && ch.toLowerCase() === "o") {
        setVerbose((v) => !v);
      }
    },
    { isActive: interactive },
  );

  /** 本轮已发送过中断（重复按 Esc/Ctrl+C 不再刷提示，等当前命令退出） */
  const abortSent = useRef(false);
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
    // N2-2：中断即清空排队输入——取消当前轮后不应自动续跑后续提交
    const cleared = sessionRef.current?.commandQueue.clear() ?? 0;
    if (cleared > 0) {
      pushBlock({ kind: "info", tone: "warn", text: `已清空 ${cleared} 条排队输入（中断不续跑）` });
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
    planApproval !== null;

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
    exit,
    pushBlock: (block) => ui.getState().pushBlock(block),
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
    exit,
  });

  /** N2-2：本轮结束即取下一条排队输入递归执行；队列空则停（中断路径已 clear，取消不续跑） */
  const drainQueue = async (): Promise<void> => {
    const next = sessionRef.current?.commandQueue.dequeue();
    if (next !== undefined) {
      await dispatch(next.text);
    }
  };

  /**
   * N2-2 占位执行：reservation 拿不到（双 turn 竞态）则入队而非抛错；
   * 完成/中断释放并排空。四个占引擎的路径（!命令 / /skill / 自定义命令 / 纯文本）共用。
   */
  const runOccupied = async (session: SessionHandle, text: string, work: () => Promise<unknown>): Promise<void> => {
    if (!session.commandQueue.tryReserve()) {
      session.commandQueue.enqueue(text);
      pushBlock({ kind: "info", text: `⧗ 已排队（第 ${session.commandQueue.size} 位）` });
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
      exit();
      return;
    }
    if (ui.getState().busy) {
      const session = sessionRef.current;
      session.commandQueue.enqueue(text);
      setInput("");
      saveHistory(text);
      const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      pushBlock({ kind: "info", text: `⧗ 本轮运行中，已排队（第 ${session.commandQueue.size} 位）：${preview}——Esc/Ctrl+C 中断将清空排队` });
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
        runOccupied,
        saveHistory,
        beginWork,
        resetAbortSent: () => { abortSent.current = false; },
        createSession,
        handleEvent,
        appendDelta: stream.appendDelta,
        appendReasoning: stream.appendReasoning,
        asker,
        askUser,
        onPlanApproval,
        onQueueChange: (items) => ui.getState().setQueuedCount(items.length),
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
  useTerminalTitle(busy, activityLabel);
  useCompletionBell(busy, busySince);

  if (fatal !== null) {
    return (
      <Text color={c("destructive")}>✗ {fatal}</Text>
    );
  }

  const meta = MODE_META[mode];
  const busyElapsed =
    busy && busySince !== null && tick > busySince ? ` (${((tick - busySince) / 1000).toFixed(1)}s)` : "";

  return (
    <ServicesProvider
      services={{
        // N3-2 注 E：前端只拿 PlatformClientPort（probe/saveKey），完整实现留在宿主侧
        platform: platformClientAdapter(props.runtime.platform),
        ui,
        getSession: () => sessionRef.current,
        dialogs: {
          setMode,
          applyMode,
          switchSession,
          rewind: (eventIndex: number) =>
            sessionRef.current?.rewind(eventIndex) ?? Promise.resolve("会话未就绪"),
          setModel: async (ref: string) => {
            try {
              await sessionRef.current?.setModel(ref);
              return null;
            } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          },
          setModelLabel,
          clearPersistentGrants: async () => {
            await sessionRef.current?.clearPersistentGrants();
            return true;
          },
          pushBlock,
          setAsk,
          setQuestion,
          setPlanApproval,
          setRewindPicker,
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
            {notice}
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
          resumePicker={resumePicker}
          permissionsPanel={permissionsPanel}
          fullAccessConfirm={fullAccessConfirm}
          loginWizard={loginWizard}
          modelPicker={modelPicker}
        >
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
            onCjkCommit={pingRepaint}
          />
        </DialogLayer>
        <StatusBar
          modeLabel={meta.label}
          modelLabel={modelLabel}
          verbose={verbose}
          repaintTick={repaintTick}
          busy={busy}
          usage={usage}
          branch={branch}
        />
      </Box>
    </ServicesProvider>
  );
}

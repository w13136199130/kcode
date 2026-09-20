import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type {
  AskPreviewPayload,
  PermissionAnswer,
  PermissionMode,
  PermissionAsker,
  SessionEvent,
  StructuredQuestion,
  TodoItem,
  ToolCallRef,
  UserPromptPort,
} from "@kcode/contracts";
import type { DaemonClient } from "../daemon-client.js";
import { createSession } from "../session.js";
import { TodoPanel, Transcript, type Block } from "./Transcript.js";

export interface KcodeAppProps {
  /** 守护进程连接：会话在守护进程侧组装与执行 */
  client: DaemonClient;
  model: string;
  cwd: string;
  /** 一次性提问（非交互/脚本模式）；缺省进 REPL */
  oneShot?: string;
  /** 一次性提问附图（本地文件路径，多模态输入） */
  images?: string[];
  /** 续接来源（会话 id / 前缀 / latest，由守护进程解析重建） */
  resumeFrom?: string;
}

/** 四档权限模式的界面元数据（与 extensions/RULES_BY_MODE 一一对应） */
const MODE_META: Record<PermissionMode, { icon: string; label: string; hint: string; color: string }> = {
  plan: { icon: "🔒", label: "计划模式·只读", hint: "只读研究，写/命令将被拒绝", color: "magenta" },
  default: { icon: "🛡️", label: "变更确认", hint: "读放行，写/命令逐次确认", color: "cyan" },
  acceptEdits: { icon: "✏️", label: "自动编辑", hint: "文件编辑自动放行，命令仍确认", color: "green" },
  fullAccess: { icon: "⚡", label: "完全访问", hint: "全自动（谨慎使用）", color: "red" },
};

/** /mode 循环切换顺序：fullAccess 不进循环，只能显式指定并确认 */
const MODE_CYCLE: PermissionMode[] = ["plan", "default", "acceptEdits"];

interface AskState {
  call: ToolCallRef & { preview?: AskPreviewPayload };
  resolve: (answer: PermissionAnswer) => void;
}

interface QuestionState {
  question: StructuredQuestion;
  resolve: (labels: string[]) => void;
}

export interface MenuOption {
  /** 快捷键（单选时按下即选中并确认；多选时忽略） */
  key: string;
  label: string;
}

/**
 * 方向键选项菜单（对标 Claude Code 权限确认交互）：
 * ↑↓ 移动高亮（按键输入实时可见），回车确认选中项，Esc 取消；
 * 单选模式数字/快捷键直达，多选模式空格切换勾选。
 */
function OptionsMenu(props: {
  options: MenuOption[];
  multi?: boolean;
  /** 初始高亮项（危险操作默认停在取消项） */
  initialIndex?: number;
  onPick: (indices: number[]) => void;
  onCancel: () => void;
}) {
  const count = props.options.length;
  const [selected, setSelected] = useState(props.initialIndex ?? 0);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  useInput((ch, key) => {
    if (key.upArrow) {
      setSelected((s) => (s - 1 + count) % count);
      return;
    }
    if (key.downArrow) {
      setSelected((s) => (s + 1) % count);
      return;
    }
    if (key.return) {
      if (props.multi === true) {
        props.onPick([...checked]);
      } else {
        props.onPick([selected]);
      }
      return;
    }
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (props.multi === true && ch === " ") {
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(selected)) {
          next.delete(selected);
        } else {
          next.add(selected);
        }
        return next;
      });
      return;
    }
    if (props.multi !== true) {
      const idx = props.options.findIndex((o) => o.key === ch.toLowerCase());
      if (idx !== -1) {
        props.onPick([idx]);
      }
    }
  });
  return (
    <Box flexDirection="column">
      {props.options.map((o, i) => {
        const highlighted = i === selected;
        const marker =
          props.multi === true ? (checked.has(i) ? "☒" : "☐") : highlighted ? "❯" : " ";
        return (
          <Text key={o.key} color={highlighted ? "cyan" : undefined} bold={highlighted}>
            {marker} {i + 1}. {o.label}
          </Text>
        );
      })}
      <Text dimColor>
        {props.multi === true
          ? " ↑↓ 移动 · 空格勾选 · 回车确认 · Esc 取消"
          : " ↑↓/数字 选择 · 回车确认 · Esc 取消"}
      </Text>
    </Box>
  );
}

/** diff 预览行渲染：- 红 / + 绿 / 上下文 dim；行数超限截断 */
const PREVIEW_MAX_LINES = 20;

function DiffPreview(props: { preview: AskPreviewPayload }) {
  const lines = props.preview.diff.split("\n");
  const shown = lines.slice(0, PREVIEW_MAX_LINES);
  return (
    <Box flexDirection="column">
      {props.preview.path !== undefined && (
        <Text color="cyan" bold>
          {"  "}
          {props.preview.path}
        </Text>
      )}
      {shown.map((line, i) => (
        <Text
          key={i}
          color={line.startsWith("+") ? "green" : line.startsWith("-") ? "red" : undefined}
          dimColor={!line.startsWith("+") && !line.startsWith("-")}
        >
          {"  "}
          {line.slice(0, 120)}
        </Text>
      ))}
      {lines.length > PREVIEW_MAX_LINES && (
        <Text dimColor>
          {"  "}…（共 {lines.length} 行，已截断）
        </Text>
      )}
    </Box>
  );
}

/** 输入框——仅交互 TTY 挂载 */
function InputBox(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}) {
  return (
    <Box>
      <Text dimColor>kcode&gt; </Text>
      <TextInput value={props.value} onChange={props.onChange} onSubmit={props.onSubmit} />
    </Box>
  );
}

/** kcode 主界面：流式输出、工具状态、菜单式确认（diff 预览）、Todo 面板、结构化提问、四档权限模式 */
export function KcodeApp(props: KcodeAppProps) {
  const { exit } = useApp();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [streamText, setStreamText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busySince, setBusySince] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [ask, setAsk] = useState<AskState | null>(null);
  const [question, setQuestion] = useState<QuestionState | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [mode, setMode] = useState<PermissionMode>("default");
  const [modelLabel, setModelLabel] = useState(props.model);
  const [fullAccessConfirm, setFullAccessConfirm] = useState(false);
  const [input, setInput] = useState("");
  /** 转写展开态（Ctrl+O 切换）：思考全文 / 工具输出多行 */
  const [verbose, setVerbose] = useState(false);
  /** 驱动 running 态动态耗时与 busy 计时的时钟（250ms 一拍） */
  const [tick, setTick] = useState(Date.now());
  const sessionRef = useRef<Awaited<ReturnType<typeof createSession>> | null>(null);
  const streamRef = useRef("");
  const reasoningRef = useRef("");
  const reasoningStartedAt = useRef<number | null>(null);
  const interactive = process.stdin.isTTY === true;
  const [reasoningText, setReasoningText] = useState("");

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
      // 思考增量合帧刷显：reasoning delta 量大，逐条 setState 会拖垮 Ink 渲染
      setReasoningText(reasoningRef.current);
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

  const pushBlock = (block: Block): void => {
    setBlocks((prev) => [...prev, block]);
  };

  const appendDelta = (delta: string): void => {
    streamRef.current += delta;
    setStreamText(streamRef.current);
  };

  const appendReasoning = (delta: string): void => {
    if (reasoningStartedAt.current === null) {
      reasoningStartedAt.current = Date.now();
    }
    reasoningRef.current += delta;
  };

  /** 把流式缓冲定格为完成块（工具调用开始或轮次完成时）；思考折叠为单行摘要 */
  const flushStream = (): void => {
    if (reasoningRef.current !== "") {
      const text = reasoningRef.current;
      const ms =
        reasoningStartedAt.current !== null ? Date.now() - reasoningStartedAt.current : undefined;
      reasoningRef.current = "";
      reasoningStartedAt.current = null;
      setReasoningText("");
      pushBlock({ kind: "reasoning", text, ...(ms !== undefined ? { ms } : {}) });
    }
    if (streamRef.current !== "") {
      const text = streamRef.current;
      streamRef.current = "";
      setStreamText("");
      pushBlock({ kind: "assistant", text });
    }
  };

  /** 手动 /skill 注入：下一轮 user_message 不整段回显（daemon 侧仍落盘） */
  const suppressNextUserBlock = useRef(false);

  const handleEvent = (event: SessionEvent): void => {
    switch (event.type) {
      case "user_message":
        if (suppressNextUserBlock.current) {
          suppressNextUserBlock.current = false;
          break;
        }
        pushBlock({ kind: "user", text: event.content });
        break;
      case "tool_call":
        flushStream();
        pushBlock({
          kind: "tool",
          callId: event.callId,
          tool: event.tool,
          argsPreview: JSON.stringify(event.args).slice(0, 80),
          status: "running",
          startedAt: Date.now(),
        });
        break;
      case "tool_result":
        setBlocks((prev) =>
          prev.map((b) => {
            if (b.kind !== "tool" || b.callId !== event.callId) return b;
            const full = event.output !== "" ? event.output : (event.error ?? "");
            const summary = full.split("\n")[0]?.slice(0, 120) ?? "";
            return {
              ...b,
              status: event.ok ? "done" : "failed",
              summary,
              output: full.slice(0, 2000),
              ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
            };
          }),
        );
        break;
      case "assistant_message":
        if (streamRef.current !== "") {
          flushStream();
        } else {
          pushBlock({ kind: "assistant", text: event.content });
        }
        break;
      case "compaction_summary":
        pushBlock({ kind: "info", text: `⑂ ${event.summary}` });
        break;
      case "todo_update":
        setTodos(event.todos);
        break;
      case "skill_used":
        pushBlock({
          kind: "info",
          text: `📖 技能 ${event.skill} 已加载（${event.trigger === "auto" ? "自动触发" : "手动"}）`,
        });
        break;
      default:
        break;
    }
  };

  /** 应用模式切换：本地状态 + 守护进程侧引擎换档 */
  const applyMode = (next: PermissionMode): void => {
    setMode(next);
    sessionRef.current?.setMode(next);
    pushBlock({ kind: "info", text: `${MODE_META[next].icon} 已切换：${MODE_META[next].label}（${MODE_META[next].hint}）` });
  };

  const asker: PermissionAsker = {
    confirm: (call) =>
      new Promise<boolean | PermissionAnswer>((resolve) => {
        if (!interactive) {
          // 非交互环境（管道/CI）自动拒绝——automation 同款语义（§5.5）
          setNotice(`非交互环境，已自动拒绝 ${call.tool}`);
          resolve(false);
          return;
        }
        setAsk({ call: call as AskState["call"], resolve });
      }),
  };

  const askUser: UserPromptPort = {
    ask: (q) =>
      new Promise<string[]>((resolve) => {
        if (!interactive) {
          resolve([]);
          return;
        }
        setQuestion({ question: q, resolve });
      }),
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const handle = await createSession({
          client: props.client,
          model: props.model,
          cwd: props.cwd,
          resumeFrom: props.resumeFrom,
          onEvent: (e) => {
            if (!cancelled) handleEvent(e);
          },
          onDelta: (d) => {
            if (!cancelled) appendDelta(d);
          },
          onReasoning: (d) => {
            if (!cancelled) appendReasoning(d);
          },
          onNotice: (n) => {
            if (!cancelled) setNotice(n);
          },
          asker,
          askUser,
        });
        sessionRef.current = handle;
        setReady(true);
        if (props.oneShot !== undefined) {
          setBusy(true);
          setBusySince(Date.now());
          try {
            await handle.loop.run(
              props.oneShot,
              props.images !== undefined ? { images: props.images } : {},
            );
          } finally {
            setBusy(false);
            setBusySince(null);
            setTimeout(() => exit(), 80);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setFatal(err instanceof Error ? err.message : String(err));
          setTimeout(() => exit(), 80);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (value: string): Promise<void> => {
    const text = value.trim();
    if (text === "" || busy || sessionRef.current === null) return;
    if (text === "exit" || text === "quit") {
      exit();
      return;
    }
    const session = sessionRef.current;

    if (text.startsWith("/")) {
      const body = text.slice(1);
      const spaceIndex = body.indexOf(" ");
      const name = spaceIndex === -1 ? body : body.slice(0, spaceIndex);
      const args = spaceIndex === -1 ? "" : body.slice(spaceIndex + 1).trim();
      setInput("");

      if (name === "mode") {
        const target = args === "" ? undefined : (args as PermissionMode);
        if (target === undefined) {
          // 循环切换（跳过 fullAccess）
          const index = MODE_CYCLE.indexOf(mode);
          const next = MODE_CYCLE[(index + 1) % MODE_CYCLE.length] ?? "default";
          applyMode(next);
          return;
        }
        if (!(target in MODE_META)) {
          pushBlock({ kind: "info", tone: "warn", text: `未知模式 ${target}：可选 plan / default / acceptEdits / fullAccess` });
          return;
        }
        if (target === "fullAccess" && mode !== "fullAccess") {
          // 全自动放行风险高：显式确认后才生效
          setFullAccessConfirm(true);
          return;
        }
        applyMode(target);
        return;
      }
      if (name === "plan") {
        // 旧命令保留为 plan ↔ default 切换别名
        applyMode(mode === "plan" ? "default" : "plan");
        return;
      }
      if (name === "model") {
        if (args === "") {
          const info = await session.models().catch(() => null);
          pushBlock({
            kind: "info",
            text:
              info === null
                ? "模型清单获取失败（守护进程连接异常）"
                : `当前模型：${modelLabel}
默认引用：${info.default ?? "（未配置）"}
providers：${info.providers.join("、") || "（无）"}
切换：/model <provider/模型名>（如 /model glm/glm-4.7）`,
          });
          return;
        }
        const error = await session.setModel(args);
        if (error !== null) {
          pushBlock({ kind: "info", tone: "warn", text: `✗ 模型切换失败：${error}` });
          return;
        }
        setModelLabel(args);
        pushBlock({ kind: "info", tone: "ok", text: `⭄ 模型已切换：${args}（历史保留）` });
        return;
      }
      if (name === "skills") {
        const skills = await session.listSkills().catch(() => null);
        pushBlock({
          kind: "info",
          text:
            skills === null || skills.length === 0
              ? "（当前会话未发现技能；可在 .kcode/skills/ 或 ~/.kcode/skills/ 添加）"
              : `已装载技能（${skills.length} 个，/skill <名称> 手动注入）：\n${skills
                  .map((s) => `· ${s.name} — ${s.description}`)
                  .join("\n")}`,
        });
        return;
      }
      if (name === "skill") {
        if (args === "") {
          pushBlock({ kind: "info", tone: "warn", text: "用法：/skill <名称>（/skills 查看清单）" });
          return;
        }
        const body = await session.skillBody(args);
        if (body === null) {
          pushBlock({ kind: "info", tone: "warn", text: `✗ 技能 ${args} 不存在（/skills 查看清单）` });
          return;
        }
        pushBlock({ kind: "info", text: `📖 手动注入技能 ${args}` });
        suppressNextUserBlock.current = true;
        setBusy(true);
        setBusySince(Date.now());
        try {
          await session.loop.run(`<skill name="${args}">
${body}
</skill>`);
        } catch (err) {
          pushBlock({ kind: "info", tone: "warn", text: `✗ ${err instanceof Error ? err.message : String(err)}` });
        } finally {
          setBusy(false);
          setBusySince(null);
        }
        return;
      }
      if (name === "sessions") {
        const sessions = await session.listSessions().catch(() => null);
        pushBlock({
          kind: "info",
          text:
            sessions === null || sessions.length === 0
              ? "（暂无历史会话）"
              : `最近会话（重启后 kcode --resume <id 前缀> 续接）：\n${sessions
                  .map((s) => `· ${s.sessionId.slice(0, 16)}… · ${s.turns} 轮 · ${s.preview || "（空）"}`)
                  .join("\n")}`,
        });
        return;
      }
      if (name === "trust") {
        await session.trustProject();
        pushBlock({ kind: "info", text: "已信任当前项目（项目级 hooks/技能/命令将生效）" });
        return;
      }
      if (name === "help") {
        const customs = session
          .listCommands()
          .map((c) => `/${c.name}${c.source === "project" ? "（项目）" : "（用户）"}`);
        const builtins = [
          "/mode [名称] 切换权限模式（plan/default/acceptEdits/fullAccess）",
          "/model [引用] 查看/切换模型（如 /model glm/glm-4.7）",
          "/skills · /skill <名称> 查看/手动注入技能",
          "/sessions 最近会话列表（--resume 续接）",
          "/plan 计划模式快捷切换",
          "/trust 信任当前项目",
          "/help 显示本帮助",
          "exit 退出",
        ];
        pushBlock({
          kind: "info",
          text: `内置命令：\n${builtins.join("\n")}${customs.length > 0 ? `\n自定义命令：\n${customs.join("\n")}` : "\n（暂无自定义命令，可在 .kcode/commands/*.md 添加）"}`,
        });
        return;
      }
      const expanded = await session.expandCommand(name, args);
      if (expanded === null) {
        pushBlock({ kind: "info", text: `未知命令 /${name}（/help 查看可用命令）` });
        return;
      }
      setBusy(true);
      setBusySince(Date.now());
      try {
        await session.loop.run(expanded);
      } catch (err) {
        pushBlock({ kind: "info", tone: "warn", text: `✗ ${err instanceof Error ? err.message : String(err)}` });
      } finally {
        setBusy(false);
        setBusySince(null);
      }
      return;
    }

    setInput("");
    setBusy(true);
    setBusySince(Date.now());
    try {
      await session.loop.run(text);
    } catch (err) {
      pushBlock({ kind: "info", tone: "warn", text: `✗ ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(false);
      setBusySince(null);
    }
  };

  if (fatal !== null) {
    return (
      <Text color="red">✗ {fatal}</Text>
    );
  }

  const meta = MODE_META[mode];
  const busyElapsed =
    busy && busySince !== null && tick > busySince ? ` (${((tick - busySince) / 1000).toFixed(1)}s)` : "";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} width="100%">
      <Text wrap="truncate-end">
        <Text color="cyan" bold>
          kcode
        </Text>
        <Text color={meta.color} bold>
          {" "}
          {meta.icon} {meta.label}
        </Text>
        <Text dimColor>
          {" "}
          {modelLabel} · /mode 切换{verbose ? " · 展开视图" : ""} · exit 退出
        </Text>
      </Text>
      <Transcript blocks={blocks} streamText={streamText} reasoningText={reasoningText} verbose={verbose} now={tick} />
      {todos.length > 0 && <TodoPanel todos={todos} />}
      {notice !== null && (
        <Text color="yellow" wrap="truncate-end">
          {notice}
        </Text>
      )}
      {ask !== null ? (
        <Box flexDirection="column">
          <Text color="magenta">
            ⚠ 允许 {ask.call.tool} {JSON.stringify(ask.call.args).slice(0, 80)} ？
          </Text>
          {ask.call.preview !== undefined && <DiffPreview preview={ask.call.preview} />}
          <OptionsMenu
            options={[
              { key: "y", label: "允许" },
              { key: "a", label: "允许，本会话不再询问" },
              { key: "n", label: "拒绝" },
            ]}
            onPick={(indices) => {
              const picked = indices[0] ?? 2;
              const answer: PermissionAnswer =
                picked === 0
                  ? { allowed: true }
                  : picked === 1
                    ? { allowed: true, scope: "session" }
                    : { allowed: false };
              ask.resolve(answer);
              setAsk(null);
              pushBlock({
                kind: "info",
                tone: answer.allowed ? "ok" : "deny",
                text: `❯ ${picked === 0 ? "允许" : picked === 1 ? "允许（本会话）" : "拒绝"} · ${ask.call.tool}`,
              });
            }}
            onCancel={() => {
              ask.resolve({ allowed: false });
              setAsk(null);
              pushBlock({ kind: "info", tone: "deny", text: `❯ 拒绝 · ${ask.call.tool}` });
            }}
          />
        </Box>
      ) : fullAccessConfirm ? (
        <Box flexDirection="column">
          <Text color="red" bold>
            ⚠ 切换到完全访问？此会话内全部工具（含 bash）自动放行。
          </Text>
          <OptionsMenu
            options={[
              { key: "n", label: "取消" },
              { key: "y", label: "确认切换（全部自动放行）" },
            ]}
            initialIndex={0}
            onPick={(indices) => {
              setFullAccessConfirm(false);
              if ((indices[0] ?? 0) === 1) {
                applyMode("fullAccess");
              } else {
                pushBlock({ kind: "info", text: "❯ 取消 · 未切换完全访问" });
              }
            }}
            onCancel={() => {
              setFullAccessConfirm(false);
              pushBlock({ kind: "info", text: "❯ 取消 · 未切换完全访问" });
            }}
          />
        </Box>
      ) : question !== null ? (
        <Box flexDirection="column">
          <Text color="magenta" bold>
            ? {question.question.question}
          </Text>
          <OptionsMenu
            options={question.question.options.map((o) => ({
              key: String(question.question.options.indexOf(o) + 1),
              label: o.label + (o.description !== undefined ? ` — ${o.description}` : ""),
            }))}
            multi={question.question.multiSelect === true}
            onPick={(indices) => {
              const labels = indices.map((i) => question.question.options[i]?.label ?? "");
              question.resolve(labels);
              setQuestion(null);
              pushBlock({
                kind: "info",
                text: `→ 已选：${labels.length > 0 ? labels.join("、") : "（未选择）"}`,
              });
            }}
            onCancel={() => {
              question.resolve([]);
              setQuestion(null);
              pushBlock({ kind: "info", text: "→ 已选：（未选择）" });
            }}
          />
        </Box>
      ) : ready ? (
        busy ? (
          <Text dimColor>
            {" "}
            {reasoningText !== "" ? "✻ 思考中" : " … 处理中"}
            {busyElapsed}（Ctrl+O {verbose ? "折叠" : "展开"} · Ctrl+C 退出）
          </Text>
        ) : interactive ? (
          <InputBox value={input} onChange={setInput} onSubmit={(v) => void submit(v)} />
        ) : (
          <Text dimColor>（非交互模式：仅执行一次性提问后退出）</Text>
        )
      ) : (
        <Text dimColor>初始化会话…</Text>
      )}
    </Box>
  );
}

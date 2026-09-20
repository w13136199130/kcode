import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type {
  ChatMessage,
  LLMProvider,
  PermissionAsker,
  SessionEvent,
  StructuredQuestion,
  TodoItem,
  ToolCallRef,
  UserPromptPort,
} from "@kcode/contracts";
import { createSession } from "../session.js";
import { TodoPanel, Transcript, type Block } from "./Transcript.js";

export interface KcodeAppProps {
  llm: LLMProvider;
  model: string;
  cwd: string;
  /** 一次性提问（非交互/脚本模式）；缺省进 REPL */
  oneShot?: string;
  /** 一次性提问附图（本地文件路径，多模态输入） */
  images?: string[];
  /** 续接种子历史（--resume） */
  resumeFrom?: ChatMessage[];
}

interface AskState {
  call: ToolCallRef;
  resolve: (allowed: boolean) => void;
}

interface QuestionState {
  question: StructuredQuestion;
  resolve: (labels: string[]) => void;
}

/** y/N 按键捕获——仅在交互 TTY 下挂载（useInput 在非 TTY stdin 上会抛错） */
function AskCatcher(props: { onAnswer: (allowed: boolean) => void }) {
  useInput((ch, key) => {
    if (key.return) {
      props.onAnswer(false);
      return;
    }
    const c = ch.toLowerCase();
    if (c === "y") {
      props.onAnswer(true);
    } else if (c === "n") {
      props.onAnswer(false);
    }
  });
  return null;
}

/** 结构化提问选择器：数字键选择（multiSelect 可多选），回车确认 */
function QuestionCatcher(props: { multi: boolean; count: number; onDone: (indices: number[]) => void }) {
  const [picked, setPicked] = useState<number[]>([]);
  useInput((ch, key) => {
    if (key.return) {
      props.onDone(props.multi ? picked : picked.slice(-1));
      return;
    }
    const n = Number.parseInt(ch, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= props.count) {
      setPicked((prev) =>
        props.multi
          ? prev.includes(n - 1)
            ? prev.filter((x) => x !== n - 1)
            : [...prev, n - 1]
          : [n - 1],
      );
    }
  });
  return null;
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

/** kcode 主界面（P1-5/P1-6）：流式输出、工具状态、y/N 确认、Todo 面板、结构化提问、计划模式 */
export function KcodeApp(props: KcodeAppProps) {
  const { exit } = useApp();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [streamText, setStreamText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [ask, setAsk] = useState<AskState | null>(null);
  const [question, setQuestion] = useState<QuestionState | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [planMode, setPlanMode] = useState(false);
  const [input, setInput] = useState("");
  const sessionRef = useRef<Awaited<ReturnType<typeof createSession>> | null>(null);
  const streamRef = useRef("");
  const interactive = process.stdin.isTTY === true;

  const pushBlock = (block: Block): void => {
    setBlocks((prev) => [...prev, block]);
  };

  const appendDelta = (delta: string): void => {
    streamRef.current += delta;
    setStreamText(streamRef.current);
  };

  /** 把流式缓冲定格为完成块（工具调用开始或轮次完成时） */
  const flushStream = (): void => {
    if (streamRef.current !== "") {
      const text = streamRef.current;
      streamRef.current = "";
      setStreamText("");
      pushBlock({ kind: "assistant", text });
    }
  };

  const handleEvent = (event: SessionEvent): void => {
    switch (event.type) {
      case "user_message":
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
        });
        break;
      case "tool_result":
        setBlocks((prev) =>
          prev.map((b) => {
            if (b.kind !== "tool" || b.callId !== event.callId) return b;
            const summary =
              (event.output !== "" ? event.output : (event.error ?? "")).split("\n")[0]?.slice(0, 120) ?? "";
            return { ...b, status: event.ok ? "done" : "failed", summary };
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

  const asker: PermissionAsker = {
    confirm: (call) =>
      new Promise<boolean>((resolve) => {
        if (!interactive) {
          // 非交互环境（管道/CI）自动拒绝——automation 同款语义（§5.5）
          setNotice(`非交互环境，已自动拒绝 ${call.tool}`);
          resolve(false);
          return;
        }
        setAsk({ call, resolve });
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
          llm: props.llm,
          model: props.model,
          cwd: props.cwd,
          resumeFrom: props.resumeFrom,
          onEvent: (e) => {
            if (!cancelled) handleEvent(e);
          },
          onDelta: (d) => {
            if (!cancelled) appendDelta(d);
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
          try {
            await handle.loop.run(
              props.oneShot,
              props.images !== undefined ? { images: props.images } : {},
            );
          } finally {
            setBusy(false);
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

      if (name === "plan") {
        const next = !planMode;
        setPlanMode(next);
        session.setPlanMode(next);
        pushBlock({
          kind: "info",
          text: next
            ? "计划模式已开启（只读研究，写/命令将被拒绝）"
            : "已切回执行模式（写/命令需确认）",
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
        const builtins = ["/plan 切换计划模式", "/trust 信任当前项目", "/help 显示本帮助", "exit 退出"];
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
      try {
        await session.loop.run(expanded);
      } catch (err) {
        pushBlock({ kind: "info", text: `✗ ${err instanceof Error ? err.message : String(err)}` });
      } finally {
        setBusy(false);
      }
      return;
    }

    setInput("");
    setBusy(true);
    try {
      await session.loop.run(text);
    } catch (err) {
      pushBlock({ kind: "info", text: `✗ ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(false);
    }
  };

  if (fatal !== null) {
    return (
      <Text color="red">✗ {fatal}</Text>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text>
        <Text color="cyan" bold>
          kcode
        </Text>
        <Text color={planMode ? "magenta" : undefined} bold={planMode}>
          {planMode ? " [计划模式·只读]" : ""}
        </Text>
        <Text dimColor>
          {" "}
          {props.model} · 读放行 / 写·命令确认 · /plan 切计划 · exit 退出
        </Text>
      </Text>
      <Transcript blocks={blocks} streamText={streamText} />
      {todos.length > 0 && <TodoPanel todos={todos} />}
      {notice !== null && (
        <Text color="yellow" wrap="truncate-end">
          {notice}
        </Text>
      )}
      {ask !== null ? (
        <>
          <AskCatcher
            onAnswer={(allowed) => {
              ask.resolve(allowed);
              setAsk(null);
            }}
          />
          <Text color="magenta">
            ⚠ 允许 {ask.call.tool} {JSON.stringify(ask.call.args).slice(0, 80)} ？ [y/N]
          </Text>
        </>
      ) : question !== null ? (
        <>
          <QuestionCatcher
            multi={question.question.multiSelect === true}
            count={question.question.options.length}
            onDone={(indices) => {
              question.resolve(indices.map((i) => question.question.options[i]?.label ?? ""));
              setQuestion(null);
            }}
          />
          <Box flexDirection="column">
            <Text color="magenta" bold>
              ? {question.question.question}
            </Text>
            {question.question.options.map((o, i) => (
              <Text key={i}>
                {" "}
                {i + 1}. {o.label}
                {o.description !== undefined ? ` — ${o.description}` : ""}
              </Text>
            ))}
            <Text dimColor>
              {question.question.multiSelect === true ? "数字切换选择，回车确认" : "输入数字选择"}
            </Text>
          </Box>
        </>
      ) : ready ? (
        busy ? (
          <Text dimColor> … 处理中（Ctrl+C 中断）</Text>
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

import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { LLMProvider, PermissionAsker, SessionEvent, ToolCallRef } from "@kcode/contracts";
import { createSession } from "../session.js";
import { Transcript, type Block } from "./Transcript.js";

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

export interface KcodeAppProps {
  llm: LLMProvider;
  model: string;
  cwd: string;
  /** 一次性提问（非交互/脚本模式）；缺省进 REPL */
  oneShot?: string;
}

interface AskState {
  call: ToolCallRef;
  resolve: (allowed: boolean) => void;
}

/** kcode 主界面（P1-5）：流式输出、工具状态行、y/N 确认、后台任务通知 */
export function KcodeApp(props: KcodeAppProps) {
  const { exit } = useApp();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [streamText, setStreamText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [ask, setAsk] = useState<AskState | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const handle = await createSession({
          llm: props.llm,
          model: props.model,
          cwd: props.cwd,
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
        });
        sessionRef.current = handle;
        setReady(true);
        if (props.oneShot !== undefined) {
          setBusy(true);
          try {
            await handle.loop.run(props.oneShot);
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
    const question = value.trim();
    if (question === "" || busy || sessionRef.current === null) return;
    if (question === "exit" || question === "quit") {
      exit();
      return;
    }
    setInput("");
    setBusy(true);
    try {
      await sessionRef.current.loop.run(question);
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
        <Text dimColor>
          {" "}
          {props.model} · 读放行 / 写·命令确认 · exit 退出
        </Text>
      </Text>
      <Transcript blocks={blocks} streamText={streamText} />
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

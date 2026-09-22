import { Box, Text, useStdout } from "ink";
import type { TodoItem } from "@kcode/contracts";
import { markdownToLines, type MdLine } from "./markdown.js";
// 实现移至 width.ts（避免与 markdown 循环导入）；re-export 保持既有导入路径（App 等）
import { visualWidth, wrapVisual } from "./width.js";

export { visualWidth, wrapVisual };

export type Block =
  | { kind: "banner"; model: string; cwd: string }
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "reasoning"; text: string; ms?: number }
  | {
      kind: "tool";
      callId: string;
      tool: string;
      argsPreview: string;
      status: "running" | "done" | "failed";
      summary?: string;
      /** 完整输出（截断 2000 字符）：verbose 展开态渲染多行 */
      output?: string;
      /** 开始时间戳：running 态渲染动态耗时 */
      startedAt?: number;
      /** 执行耗时（完成态渲染；来自 tool_result.durationMs） */
      durationMs?: number;
    }
  | { kind: "info"; text: string; tone?: "ok" | "deny" | "warn" };

/** Todo 面板（§1.1 A 域）：☐ 待办 / ◐ 进行 / ☑ 完成 */
export function TodoPanel(props: { todos: TodoItem[] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {props.todos.map((t, i) => (
        <Text
          key={i}
          color={t.status === "completed" ? "green" : t.status === "in_progress" ? "cyan" : undefined}
          dimColor={t.status === "completed"}
        >
          {t.status === "completed" ? "☑" : t.status === "in_progress" ? "◐" : "☐"} {t.content}
          {t.priority === "high" ? " ！" : ""}
        </Text>
      ))}
    </Box>
  );
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 按工具智能提取参数预览（替代原始 JSON 转写）：
 * bash 显示命令、read/glob/grep 显示路径与 pattern、write/edit 显示目标文件。
 */
export function formatToolPreview(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const s = (v: unknown): string => (typeof v === "string" ? v : "");
  const clip = (t: string, max = 60): string =>
    t.length > max ? `${t.slice(0, max)}…` : t;
  switch (tool) {
    case "bash":
      return clip(s(a.command).replace(/\s+/g, " "));
    case "read": {
      const range =
        a.offset !== undefined || a.limit !== undefined
          ? `:${a.offset ?? 1}${a.limit !== undefined ? `+${a.limit}` : ""}`
          : "";
      return clip(`${s(a.path)}${range}`);
    }
    case "glob":
    case "grep":
      return clip(`${s(a.pattern)}${s(a.path) !== "" ? ` @ ${s(a.path)}` : ""}`);
    case "write":
    case "edit":
      return clip(s(a.path));
    case "todo":
      return "更新任务清单";
    case "ask_user":
      return clip(s(a.question));
    case "sessions":
      return s(a.action);
    default:
      return clip(JSON.stringify(args));
  }
}

/** verbose 态工具输出最多渲染行数 */
const VERBOSE_TOOL_LINES = 12;
/** 思考块展开态最多渲染行数 */
const VERBOSE_REASONING_LINES = 30;

/**
 * 单个转写块的渲染（Static 滚动区与活跃区共用）。
 * Static 中的块一经打印不再更新——工具块只有在完成（done/failed）后才应进入 Static。
 * 符号系统对齐主流 CLI：⏺ 助手 / ✻ 思考 / ⎿ 结果——全部等宽字形，不用 emoji。
 */
export function BlockView(props: { block: Block; verbose?: boolean; now?: number }) {
  const block = props.block;
  const { stdout } = useStdout();
  if (block.kind === "banner") {
    return (
      <Box marginBottom={1}>
        <Box marginRight={2} flexDirection="column">
          <Text color="cyan" bold>
            {"█   █  █████  █████  █████"}
          </Text>
          <Text color="cyan" bold>
            {"█  █  ██     ██     ██"}
          </Text>
          <Text color="cyan" bold>
            {"████  ██     ██     ██"}
          </Text>
          <Text color="cyan" bold>
            {"█   █  █████  █████  █████"}
          </Text>
          <Text dimColor> </Text>
          <Text>
            <Text color="cyan">kcode</Text>
            <Text dimColor> · 本地优先代码助手</Text>
          </Text>
          <Text dimColor wrap="truncate-end">
            {block.model}
          </Text>
          <Text dimColor wrap="truncate-end">
            {block.cwd}
          </Text>
        </Box>
        <Box flexDirection="column" paddingTop={1}>
          <Text color="yellow" bold>
            Tips for getting started
          </Text>
          <Text dimColor>输入 / 弹出命令菜单；/login 配置厂商与 key</Text>
          <Text dimColor>/mode 权限模式 · /model 换模型 · Ctrl+O 展开思考</Text>
          <Text dimColor>↑↓ 翻输入历史 · /help 全部命令 · exit 退出</Text>
        </Box>
      </Box>
    );
  }
  if (block.kind === "user") {
    // 用户消息：暗色 > 前缀（Claude Code 现行风格；多行折行显示）
    void stdout;
    const lines = wrapVisual(block.text, (stdout.columns ?? 80) - 2);
    return (
      <Box flexDirection="column">
        {lines.map((l, j) => (
          <Text key={j} color="green" dimColor wrap="wrap">
            {j === 0 ? "> " : "  "}
            {l}
          </Text>
        ))}
      </Box>
    );
  }
  if (block.kind === "assistant") {
    // 落定的助手消息按 Markdown 渲染（KCODE_NO_MD=1 逃生口回退纯文本）；
    // 流式期间 App 层的 streamText 仍是纯文本——避免未闭合围栏的结构抖动
    const lines: MdLine[] =
      process.env["KCODE_NO_MD"] === "1"
        ? block.text.split("\n").map((l) => ({ segments: [{ text: l }] }))
        : markdownToLines(block.text);
    return (
      <Box flexDirection="column">
        {lines.map((line, j) => (
          <Text key={j}>
            {j === 0 ? <Text color="green">⏺ </Text> : null}
            {line.segments.map((s, k) => (
              <Text
                key={k}
                color={s.color}
                bold={s.bold}
                italic={s.italic}
                dimColor={s.dimColor}
                strikethrough={s.strikethrough}
              >
                {s.text}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
    );
  }
  if (block.kind === "reasoning") {
    const timing = block.ms !== undefined ? ` ${formatMs(block.ms)}` : "";
    if (props.verbose === true) {
      const lines = block.text.split("\n").slice(0, VERBOSE_REASONING_LINES);
      return (
        <Box flexDirection="column">
          <Text dimColor italic>
            ✻ 思考{timing}（{block.text.length} 字）
          </Text>
          {lines.map((line, j) => (
            <Text key={j} dimColor italic wrap="truncate-end">
              {"  "}
              {line.slice(0, 120)}
            </Text>
          ))}
        </Box>
      );
    }
    // 折叠态只报时长 + 展开提示（预览文本混排观感差，砍掉）
    return (
      <Text dimColor italic>
        ✻ 思考{timing}（Ctrl+O 展开）
      </Text>
    );
  }
  if (block.kind === "info") {
    const color =
      block.tone === "ok"
        ? "green"
        : block.tone === "deny"
          ? "red"
          : block.tone === "warn"
            ? "yellow"
            : undefined;
    return (
      <Text color={color} dimColor={block.tone === undefined}>
        {block.text}
      </Text>
    );
  }
  const icon = block.status === "running" ? "⚡" : block.status === "done" ? "✓" : "✗";
  const color = block.status === "failed" ? "red" : block.status === "running" ? "yellow" : "blue";
  const timing =
    block.status === "running" && block.startedAt !== undefined && props.now !== undefined
      ? ` (${formatMs(Math.max(0, props.now - block.startedAt))})`
      : block.durationMs !== undefined
        ? ` (${formatMs(block.durationMs)})`
        : "";
  return (
    <Box flexDirection="column">
      <Text color={color}>
        {icon} {block.tool} {block.argsPreview}
        {timing}
      </Text>
      {props.verbose === true && block.output !== undefined && block.output !== "" ? (
        <Box flexDirection="column">
          {block.output
            .split("\n")
            .slice(0, VERBOSE_TOOL_LINES)
            .map((line, j) => (
              <Text key={j} dimColor wrap="truncate-end">
                {"  "}
                {line.slice(0, 120)}
              </Text>
            ))}
        </Box>
      ) : (
        block.summary !== undefined &&
        block.summary !== "" && <Text dimColor>⎿ {block.summary}</Text>
      )}
    </Box>
  );
}

/** 会话转写区（兼容保留：一次性渲染全部块；主界面使用 Static 架构的 App 布局） */
export function Transcript(props: {
  blocks: Block[];
  streamText: string;
  /** 思考过程实时增量（reasoning 模型）：灰色斜体，位于正文之上 */
  reasoningText?: string;
  /** Ctrl+O 展开态：思考全文、工具输出多行 */
  verbose?: boolean;
  now?: number;
}) {
  return (
    <Box flexDirection="column">
      {props.blocks.map((block, i) => (
        <BlockView key={i} block={block} verbose={props.verbose} now={props.now} />
      ))}
      {props.reasoningText !== undefined && props.reasoningText !== "" && (
        <Text dimColor italic wrap="truncate-end">
          ✻ {props.reasoningText.split("\n").at(-1)?.slice(-100) ?? ""}
        </Text>
      )}
      {props.streamText !== "" && <Text color="white">{props.streamText}</Text>}
    </Box>
  );
}

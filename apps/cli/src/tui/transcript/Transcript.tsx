import { Box, Text, useStdout } from "ink";
import type { TodoItem } from "@kcode/contracts";
import { markdownToLines, type MdLine } from "./markdown.js";
// 实现移至 width.ts（避免与 markdown 循环导入）；re-export 保持既有导入路径（App 等）
import { visualWidth, wrapVisual, truncateVisual } from "../terminal/width.js";
import { clipVisual, formatFileLink, linkifyStructuredPaths } from "../terminal/links.js";
import { c } from "../theme/theme.js";

export { visualWidth, wrapVisual };

export type { Block } from "@kcode/ui";
import type { Block } from "@kcode/ui";

/** Todo 面板（§1.1 A 域）：☐ 待办 / ◐ 进行 / ☑ 完成 */
export function TodoPanel(props: { todos: TodoItem[] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={c("brand")} paddingX={1}>
      {props.todos.map((t, i) => (
        <Text
          key={i}
          color={t.status === "completed" ? c("success") : t.status === "in_progress" ? c("brand") : undefined}
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
 * 路径是已知值——展示层直接包 OSC8 结构化链接（N3F-1，禁用时 formatFileLink 退化为裸文本）。
 */
export function formatToolPreview(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const s = (v: unknown): string => (typeof v === "string" ? v : "");
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const clip = (t: string, max = 60): string => clipVisual(t, max);
  const pathLink = (p: string, line?: number): string => formatFileLink(p, p, { line });
  switch (tool) {
    case "bash":
      return clip(s(a.command).replace(/\s+/g, " "));
    case "read": {
      const range =
        a.offset !== undefined || a.limit !== undefined
          ? `:${a.offset ?? 1}${a.limit !== undefined ? `+${a.limit}` : ""}`
          : "";
      return clip(`${pathLink(s(a.path), num(a.offset))}${range}`);
    }
    case "glob":
    case "grep":
      return clip(`${s(a.pattern)}${s(a.path) !== "" ? ` @ ${pathLink(s(a.path))}` : ""}`);
    case "write":
    case "edit":
      return clip(pathLink(s(a.path)));
    case "task":
      return clip(`[${s(a.subagent_type)}] ${s(a.description)}`);
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
    // 极简启动横幅（对标 Claude Code：一行标识 + 模型 + 目录 + 提示，不带 ASCII art）
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color={c("brand")} bold>● kcode</Text>
          <Text dimColor> — 本地优先代码助手</Text>
        </Text>
        <Text dimColor wrap="truncate-end">
          {`${block.model} · ${block.cwd}`}
        </Text>
        {/* 键位教学收敛为一行指路（截屏反馈：banner 太密）。Ctrl 系键位由 ghost 提示
            与 /help 承载，菜单内操作由菜单 footer 提示——不再三处重复 */}
        <Text dimColor wrap="truncate-end">
          输入 / 命令菜单 · /help 全部键位与命令
        </Text>
      </Box>
    );
  }
  if (block.kind === "user") {
    // 用户消息：> 前缀，颜色对标 Claude Code（不染色，只 dim 一档——干净不花哨）
    void stdout;
    const lines = wrapVisual(block.text, (stdout.columns ?? 80) - 4);
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {lines.map((l, j) => (
          <Text key={j} bold dimColor wrap="wrap">
            {j === 0 ? "> " : "  "}
            {l}
          </Text>
        ))}
      </Box>
    );
  }
  if (block.kind === "assistant") {
    // 助手消息：对标 Claude Code——● 首行前缀 + 全文 2 格缩进
    // 段落间距由 Markdown 源文本的空行决定（渲染器原样透传，不额外叠加）
    const lines: MdLine[] =
      process.env["KCODE_NO_MD"] === "1"
        ? block.text.split("\n").map((l) => ({ segments: [{ text: l }] }))
        : markdownToLines(block.text);
    // 找到首个非空行（标 ● 前缀），其余行一律 2 格缩进
    let firstContentIdx = lines.findIndex((l) => l.segments.map((s) => s.text).join("").trim() !== "");
    if (firstContentIdx === -1) firstContentIdx = 0;
    return (
      <Box flexDirection="column" marginBottom={1}>
        {lines.map((line, j) => (
          <Box key={j}>
            {j === firstContentIdx ? (
              <Text color={c("foregroundSubtle")}>{"● "}</Text>
            ) : (
              <Text>{"  "}</Text>
            )}
            <Text>
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
          </Box>
        ))}
      </Box>
    );
  }
  if (block.kind === "reasoning") {
    const timing = block.ms !== undefined ? ` ${formatMs(block.ms)}` : "";
    if (props.verbose === true) {
      const lines = block.text.split("\n").slice(0, VERBOSE_REASONING_LINES);
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="gray" italic>
            {"  ✻ Thinking"}
            {timing}
          </Text>
          {lines.map((line, j) => (
            <Text key={j} color="gray" italic wrap="truncate-end">
              {"    "}
              {truncateVisual(line, 120)}
            </Text>
          ))}
        </Box>
      );
    }
    return (
      <Box marginBottom={1}>
        <Text color="gray" italic>
          {"  ✻ Thinking"}
          {timing}
        </Text>
      </Box>
    );
  }
  if (block.kind === "info") {
    const color =
      block.tone === "ok"
        ? c("success")
        : block.tone === "deny"
          ? c("destructive")
          : block.tone === "warn"
            ? c("warning")
            : undefined;
    return (
      <Box marginLeft={2} marginBottom={1}>
        <Text color={color} dimColor={block.tone === undefined}>
          {block.text}
        </Text>
      </Box>
    );
  }
  const icon = block.status === "running" ? "⚡" : block.status === "done" ? "✓" : "✗";
  const color = block.status === "failed" ? c("destructive") : block.status === "running" ? c("warning") : c("info");
  const timing =
    block.status === "running" && block.startedAt !== undefined && props.now !== undefined
      ? ` (${formatMs(Math.max(0, props.now - block.startedAt))})`
      : block.durationMs !== undefined
        ? ` (${formatMs(block.durationMs)})`
        : "";
  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={1}>
      <Text color={color}>
        {icon} {block.tool} <Text dimColor>{block.argsPreview}</Text>
        {timing}
      </Text>
      {props.verbose === true && block.output !== undefined && block.output !== "" ? (
        <Box flexDirection="column" marginLeft={2}>
          {block.output
            .split("\n")
            .slice(0, VERBOSE_TOOL_LINES)
            .map((line, j) => (
              <Text key={j} dimColor wrap="truncate-end">
                {"  "}
                {truncateVisual(linkifyStructuredPaths(line), 120)}
              </Text>
            ))}
        </Box>
      ) : (
        block.summary !== undefined &&
        block.summary !== "" && (
          <Box marginLeft={2}>
            <Text dimColor>⎿ {linkifyStructuredPaths(block.summary)}</Text>
          </Box>
        )
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
      {props.streamText !== "" && <Text>{props.streamText}</Text>}
    </Box>
  );
}

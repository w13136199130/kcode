import { useMemo } from "react";
import { Box, Text, useStdout } from "ink";
import type { TodoItem } from "@kcode/contracts";
import { markdownToLines, type MdLine } from "./markdown.js";
// 实现移至 width.ts（避免与 markdown 循环导入）；re-export 保持既有导入路径（App 等）
import { visualWidth, wrapVisual, truncateVisual } from "../terminal/width.js";
import { clipVisual, formatFileLink, linkifyStructuredPaths } from "../terminal/links.js";
import { stripEscapes } from "../terminal/sanitize.js";
import { c, glyph, rawColor } from "../theme/theme.js";

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
  const s = (v: unknown): string => (typeof v === "string" ? stripEscapes(v) : "");
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const clip = (t: string, max = 60): string => stripEscapes(clipVisual(t, max));
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
/** 长回答默认折叠：前 30 行 + 摘要脚注，Ctrl+O 展开当前轮 */
const ASSISTANT_PREVIEW_LINES = 30;
/** 3-34：失败工具卡未展开时也显示末尾行数（错误通常在尾部） */
const FAILED_TOOL_LINES = 6;
/** 思考块展开态最多渲染行数 */
const VERBOSE_REASONING_LINES = 30;

/**
 * 单个转写块的渲染（Static 滚动区与活跃区共用）。
 * Static 中的块一经打印不再更新——工具块只有在完成（done/failed）后才应进入 Static。
 * 符号系统对齐主流 CLI：⏺ 助手 / ✻ 思考 / ⎿ 结果——全部等宽字形，不用 emoji。
 */
export function BlockView(props: {
  block: Block;
  verbose?: boolean;
  now?: number;
  expandable?: boolean;
}) {
  const block = props.block;
  const { stdout } = useStdout();
  const expandable = props.expandable !== false;
  // 当前轮块会留在活区（Ctrl+O 可就地重绘）；大表格每帧重算代价高，按块文本/宽度缓存。
  const assistantLines = useMemo<MdLine[] | null>(
    () =>
      block.kind === "assistant"
        ? process.env["KCODE_NO_MD"] === "1"
          ? stripEscapes(block.text).split("\n").map((line) => ({ segments: [{ text: line }] }))
          : markdownToLines(block.text, { columns: Math.max(40, (stdout.columns ?? 100) - 2) })
        : null,
    [block, stdout.columns],
  );
  if (block.kind === "banner") {
    // 极简启动横幅（对标 Claude Code：一行标识 + 模型 + 目录 + 提示，不带 ASCII art）
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color={c("brand")} bold>{`${glyph("●", "*")} kcode`}</Text>
          <Text dimColor> — 本地优先代码助手</Text>
        </Text>
        <Text dimColor wrap="truncate-end">
          {`${stripEscapes(block.model)} · ${stripEscapes(block.cwd)}`}
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
    // 用户消息：> 前缀，CC 同款纯白不染色。marginTop 不加——上一块的 marginBottom 已留单空行
    void stdout;
    const lines = wrapVisual(stripEscapes(block.text), (stdout.columns ?? 80) - 4);
    return (
      <Box flexDirection="column" marginBottom={1}>
        {lines.map((l, j) => (
          <Text key={j} wrap="wrap">
            {j === 0 ? "> " : "  "}
            {l}
          </Text>
        ))}
        {block.images !== undefined && block.images.length > 0 ? (
          <Text dimColor>{`  📎 ${block.images.length} 张附图`}</Text>
        ) : null}
      </Box>
    );
  }
  if (block.kind === "assistant") {
    // 助手正文：CC 同款 ● 首行前缀（白，与正文同色）+ 续行 2 格缩进。
    // 首个内容行是列表项时 ● 独占一行——● • 双重列表符号是排版反馈实测。
    // 空正文块（思考模型直发工具调用）不渲染。
    const lines: MdLine[] = assistantLines ?? [];
    const firstContentIdx = lines.findIndex((l) => l.segments.map((s) => s.text).join("").trim() !== "");
    if (firstContentIdx === -1) {
      return null;
    }
    const firstText = lines[firstContentIdx]!.segments.map((s) => s.text).join("").trimStart();
    const listStart = /^(•|☐|☑|\d+\.)\s/.test(firstText);
    const folded = props.verbose !== true && lines.length > ASSISTANT_PREVIEW_LINES;
    const visibleLines = folded ? lines.slice(0, Math.max(ASSISTANT_PREVIEW_LINES, firstContentIdx + 1)) : lines;
    return (
      <Box flexDirection="column" marginBottom={1}>
        {listStart ? <Text>{glyph("●", "*")}</Text> : null}
        {visibleLines.map((line, j) => {
          const isFirst = j === firstContentIdx;
          return (
            <Box key={j}>
              {isFirst && !listStart ? <Text>{`${glyph("●", "*")} `}</Text> : isFirst ? null : <Text>{"  "}</Text>}
              <Text>
                {line.segments.map((s, k) => (
                  <Text
                    key={k}
                    color={rawColor(s.color)}
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
          );
        })}
        {folded ? (
          <Box marginLeft={2}>
            <Text color={c("foregroundSubtle")}>
              {`… 共 ${lines.length} 行 · ${expandable ? "Ctrl+O 展开当前轮" : "/export 导出全文"}`}
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  }
  if (block.kind === "reasoning") {
    // 思考行 CC 同款：过去式 + 展开提示（Thought for 1s (ctrl+o to expand)），muted 灰
    const timing = block.ms !== undefined ? ` ${formatMs(block.ms)}` : "";
    const hint = expandable ? " (ctrl+o to expand)" : "";
    if (props.verbose === true) {
      const lines = stripEscapes(block.text).split("\n").slice(0, VERBOSE_REASONING_LINES);
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={c("foregroundSubtle")}>
            {`  Thought for${timing}${expandable ? " (ctrl+o to collapse)" : ""}`}
          </Text>
          {lines.map((line, j) => (
            <Text key={j} color={c("foregroundSubtle")} wrap="truncate-end">
              {"    "}
              {truncateVisual(line, 120)}
            </Text>
          ))}
        </Box>
      );
    }
    return (
      <Box marginBottom={1}>
        <Text color={c("foregroundSubtle")}>{`  Thought for${timing}${hint}`}</Text>
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
            : c("foregroundSubtle");
    return (
      <Box marginLeft={2} marginBottom={1}>
        <Text color={color}>{stripEscapes(block.text)}</Text>
      </Box>
    );
  }
  // 工具卡（CC 配色模型）：图标+工具名承载状态色（柔和 hex——完成绿/失败红/运行天蓝，
  // zcode statusColor 同款），参数与耗时 muted 灰；done 不再整行染饱和蓝（截图反馈"太深"根因）
  const icon =
    block.status === "running" ? glyph("⚡", "*") : block.status === "done" ? glyph("✓", "+") : glyph("✗", "x");
  const color = block.status === "failed" ? c("destructive") : block.status === "running" ? c("info") : c("success");
  const timing =
    block.status === "running" && block.startedAt !== undefined && props.now !== undefined
      ? ` (${formatMs(Math.max(0, props.now - block.startedAt))})`
      : block.durationMs !== undefined
        ? ` (${formatMs(block.durationMs)})`
        : "";
  const outputLineCount =
    block.output !== undefined && block.output !== "" ? block.output.replace(/\n$/, "").split("\n").length : 0;
  const summarySuffix = outputLineCount > 1 ? ` · 共 ${outputLineCount} 行 · Ctrl+B 查看全部` : "";
  const summaryText = linkifyStructuredPaths(stripEscapes(block.summary ?? ""));
  const summaryLimit = summarySuffix === "" ? 120 : 88;
  const summaryDisplay =
    visualWidth(summaryText) > summaryLimit
      ? `${truncateVisual(summaryText, summaryLimit - 1)}…`
      : summaryText;
  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={1}>
      <Text>
        <Text color={color}>
          {icon} {stripEscapes(block.tool)}{" "}
        </Text>
        <Text color={c("foregroundSubtle")}>
          {stripEscapes(block.argsPreview)}
          {timing}
        </Text>
      </Text>
      {(props.verbose === true || block.status === "failed") && block.output !== undefined && block.output !== "" ? (
        <Box flexDirection="column" marginLeft={2}>
          {(() => {
            const lines = block.output.split("\n");
            // 3-22/3-34：失败输出默认显示末尾——构建/测试错误集中在尾部；
            // 未展开态只给 6 行提示；当前轮 Ctrl+O 展开，历史按 Ctrl+B 看全部。
            const tailMode = block.status === "failed";
            const limit = props.verbose === true ? VERBOSE_TOOL_LINES : FAILED_TOOL_LINES;
            const shown = tailMode ? lines.slice(-limit) : lines.slice(0, limit);
            const hidden = lines.length - shown.length;
            return (
              <>
                {shown.map((line, j) => (
                  <Text key={j} color={c("foregroundSubtle")} wrap="truncate-end">
                    {"  "}
                    {truncateVisual(linkifyStructuredPaths(stripEscapes(line)), 120)}
                  </Text>
                ))}
                {hidden > 0 ? (
                  <Text color={c("foregroundSubtle")}>
                    {tailMode
                      ? `  …（仅显示末尾 ${limit} 行${expandable ? " · Ctrl+O 展开" : ""} / Ctrl+B 查看全部）`
                      : `  …（共 ${lines.length} 行 · Ctrl+B 查看全部）`}
                  </Text>
                ) : null}
              </>
            );
          })()}
        </Box>
      ) : (
        block.summary !== undefined &&
        block.summary !== "" && (
          <Box marginLeft={2}>
            <Text color={c("foregroundSubtle")}>
              {glyph("⎿", "\\")} {summaryDisplay}
              {summarySuffix}
            </Text>
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

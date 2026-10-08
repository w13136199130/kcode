import { Box, Text } from "ink";
import { useStore } from "zustand";
import type { Block, UiStore } from "@kcode/ui";
import { truncateVisual } from "../terminal/width.js";
import { linkifyStructuredPaths } from "../terminal/links.js";
import { c } from "../theme/theme.js";

/**
 * 工具卡片浏览器（N3C-4②）：覆盖层面板，从 store 的 blocks 渲染历史工具调用，
 * ↑/↓ 选卡、Enter 展开/收起该卡详情（键位在 terminal/keybinds.ts 统一处理，本组件纯渲染）。
 * 为什么是覆盖层而不是改 Static 里的块：转写区已完成的块推进 scrollback 后不再重绘，
 * "逐卡展开"只能在 Static 之外的数据视图上实现——这与 opencode 的 tool details 面板同型。
 */

/** 列表窗口大小：面板最多占屏 10 行（长会话只看光标附近） */
const WINDOW = 10;
/** 展开态详情最多渲染行数（output 本身在 settle 时截 2000 字符，这里再防超长刷屏） */
const DETAIL_LINES = 40;

type ToolBlock = Extract<Block, { kind: "tool" }>;

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function ToolBrowser(props: { ui: UiStore }) {
  const blocks = useStore(props.ui, (s) => s.blocks);
  const browser = useStore(props.ui, (s) => s.toolBrowser);
  const tools = blocks.filter((b): b is ToolBlock => b.kind === "tool");

  if (tools.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={c("brand")} paddingX={1}>
        <Text dimColor>本会话还没有工具调用（Ctrl+B 或 Esc 关闭）</Text>
      </Box>
    );
  }

  const cursor = Math.min(browser.cursor, tools.length - 1);
  // 窗口以光标为中心 clamp 到列表两端
  const start = Math.max(0, Math.min(cursor - Math.floor(WINDOW / 2), tools.length - WINDOW));
  const view = tools.slice(start, start + WINDOW);
  const selected = tools[cursor];
  const expanded = selected !== undefined && browser.expandedCallId === selected.callId;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={c("brand")} paddingX={1}>
      <Text dimColor>
        工具调用 {cursor + 1}/{tools.length}
        {start > 0 ? " ↑更多" : ""}
        {start + view.length < tools.length ? " ↓更多" : ""} · ↑↓ 选择 · Enter 展开详情 · Ctrl+B/Esc 关闭
      </Text>
      {view.map((b, i) => {
        const index = start + i;
        const isSelected = index === cursor;
        const icon = b.status === "running" ? "⚡" : b.status === "failed" ? "✗" : "✓";
        const color = b.status === "failed" ? c("destructive") : b.status === "running" ? c("warning") : c("info");
        return (
          <Box key={b.callId} flexDirection="column">
            <Text color={isSelected ? c("brand") : color} bold={isSelected}>
              {isSelected ? "❯ " : "  "}
              {icon} {b.tool} <Text dimColor>{truncateVisual(b.argsPreview, 60)}</Text>
              {b.durationMs !== undefined ? ` (${formatMs(b.durationMs)})` : ""}
            </Text>
            {isSelected && expanded && <ToolDetail block={b} />}
          </Box>
        );
      })}
    </Box>
  );
}

/** 展开态详情：完整存量输出 + 摘要兜底（无输出时至少能看到一句结果） */
function ToolDetail(props: { block: ToolBlock }) {
  const text = props.block.output !== undefined && props.block.output !== "" ? props.block.output : props.block.summary ?? "";
  if (text === "") {
    return (
      <Box marginLeft={2}>
        <Text dimColor>⎿（无输出）</Text>
      </Box>
    );
  }
  const lines = text.split("\n");
  const shown = lines.slice(0, DETAIL_LINES);
  return (
    <Box flexDirection="column" marginLeft={2}>
      {shown.map((line, j) => (
        <Text key={j} dimColor wrap="truncate-end">
          {"  "}
          {truncateVisual(linkifyStructuredPaths(line), 120)}
        </Text>
      ))}
      {lines.length > DETAIL_LINES ? <Text dimColor>  …（共 {lines.length} 行，完整内容见会话 JSONL）</Text> : null}
    </Box>
  );
}

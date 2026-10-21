import { Box, Text } from "ink";
import { useStore } from "zustand";
import type { QueuedCommandView, UiStore } from "@kcode/ui";
import { truncateVisual } from "../terminal/width.js";
import { stripEscapes } from "../terminal/sanitize.js";
import { c, glyph } from "../theme/theme.js";

const MAX_VISIBLE = 4;

/**
 * 3-33：排队输入面板（输入框上方常驻）。
 * 只镜像 RuntimeCommandQueue 的快照；编辑/删除/继续由 /queue 命令操作。
 */
export function QueuePanel(props: { ui: UiStore }) {
  const items = useStore(props.ui, (s) => s.queuedItems);
  const paused = useStore(props.ui, (s) => s.queuePaused);
  if (items.length === 0) {
    return null;
  }
  const shown = items.slice(0, MAX_VISIBLE);
  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={0}>
      <Text color={paused ? c("warning") : c("foregroundSubtle")} wrap="truncate-end">
        {`${glyph("⧗", "~")} 排队 ${items.length} 条`}
        {paused ? " · 已暂停（/queue run 继续 · /queue clear 清空）" : " · 本轮结束后自动执行"}
      </Text>
      {shown.map((item: QueuedCommandView, index) => (
        <Text key={item.id} dimColor wrap="truncate-end">
          {`  ${index + 1}. ${truncateVisual(stripEscapes(item.text.replace(/\s+/g, " ")), 88)}`}
        </Text>
      ))}
      {items.length > shown.length ? (
        <Text dimColor>{`  … 还有 ${items.length - shown.length} 条（/queue 查看全部）`}</Text>
      ) : null}
    </Box>
  );
}

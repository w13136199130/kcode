import { Box, Static, Text } from "ink";
import { useStore } from "zustand";
import type { UiStore } from "@kcode/ui";
import { BlockView, TodoPanel, type Block } from "./Transcript.js";
import { rawColor } from "../theme/theme.js";

/**
 * 转写区（N2-3 外迁，3-25 修正 Live/Static 边界）：
 * - Static 只接收"第一个运行中工具之前"的块——已打印块不再重绘，长会话不整帧重印；
 * - 第一个 running 工具及其后的所有块（含 info/assistant/已完成工具）留在活区：
 *   排队提示、子代理事件插进队列后，running 卡仍会被持续重绘，不会冻结成 ⚡；
 * - 工具完成后，静态前缀自然向后生长，顺序不变且不重复打印；
 * - Ctrl+O 切换展开度时 renderEpoch 递增，Static 重新挂载重放全部定稿块（否则滚出屏幕的
 *   块永远保持旧展开态——这就是"Ctrl+O 按了没反应"的根因）。
 */
export function TranscriptView(props: { ui: UiStore; verbose: boolean; tick: number }) {
  const blocks = useStore(props.ui, (s) => s.blocks);
  const renderEpoch = useStore(props.ui, (s) => s.renderEpoch);
  const streamText = useStore(props.ui, (s) => s.streamText);
  const reasoningText = useStore(props.ui, (s) => s.reasoningText);
  const todos = useStore(props.ui, (s) => s.todos);

  // 静态/活区分界：第一个运行中的工具之后一律留在活区（含其后已定稿的块）
  let splitAt = blocks.length;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.kind === "tool" && block.status === "running") {
      splitAt = i;
      break;
    }
  }
  const finalized = blocks.slice(0, splitAt);
  const live = blocks.slice(splitAt);

  const liveKey = (block: Block, index: number): string =>
    block.kind === "tool" ? `live-tool-${block.callId}` : `live-${index}`;

  return (
    <>
      <Static key={renderEpoch} items={finalized}>
        {(block, index) => <BlockView key={index} block={block} verbose={props.verbose} />}
      </Static>
      {live.map((block, i) => (
        <BlockView key={liveKey(block, splitAt + i)} block={block} verbose={props.verbose} now={props.tick} />
      ))}
      {reasoningText !== "" && (
        <Box marginLeft={2}>
          <Text color={rawColor("gray")} italic wrap="truncate-end">
            ✻ {reasoningText.split("\n").at(-1)?.slice(-100) ?? ""}
          </Text>
        </Box>
      )}
      {streamText !== "" && (
        <Box marginLeft={2}>
          <Text>{streamText}</Text>
        </Box>
      )}
      {todos.length > 0 && <TodoPanel todos={todos} />}
    </>
  );
}

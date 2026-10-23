import { Box, Static, Text } from "ink";
import { useStore } from "zustand";
import type { UiStore } from "@kcode/ui";
import { BlockView, TodoPanel, type Block } from "./Transcript.js";
import { c } from "../theme/theme.js";

/**
 * 转写区（N2-3 外迁，3-25 修正 Live/Static 边界）：
 * - Static 只接收“当前轮之前”的块——已打印块不再重绘，长会话不整帧重印；
 * - 运行中工具及其后的块留在活区；空闲时最近一轮留在活区，Ctrl+O 可就地重绘，
 *   不再清屏重放全部历史（避免终端留下多份 transcript）；
 * - 旧轮次进 Static 后保持打印时的展开度；全文用 Ctrl+B / /export 查看。
 */
export function TranscriptView(props: { ui: UiStore; verbose: boolean; tick: number }) {
  const blocks = useStore(props.ui, (s) => s.blocks);
  const renderEpoch = useStore(props.ui, (s) => s.renderEpoch);
  const streamText = useStore(props.ui, (s) => s.streamText);
  const reasoningText = useStore(props.ui, (s) => s.reasoningText);
  const todos = useStore(props.ui, (s) => s.todos);

  // 静态/活区分界：
  // - 最近一轮（最后一个 user 起）整体留在活区：当前轮的 user/assistant/tool 都能就绪重绘，
  //   且不会在“运行中工具结束”时把已进 Static 的块拉回活区（那会导致 Static 缩短、内容重复）；
  // - 没有 user（启动横幅/直接命令）时，从第一个运行中工具起留活区；
  // - 旧轮次已进 Static，保持打印时的展开度；全文用 Ctrl+B / /export 查看。
  let splitAt = blocks.length;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]!.kind === "user") {
      splitAt = i;
      break;
    }
  }
  if (splitAt === blocks.length) {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!;
      if (block.kind === "tool" && block.status === "running") {
        splitAt = i;
        break;
      }
    }
  }
  const finalized = blocks.slice(0, splitAt);
  const live = blocks.slice(splitAt);

  const liveKey = (block: Block, index: number): string =>
    block.kind === "tool" ? `live-tool-${block.callId}` : `live-${index}`;

  return (
    <>
      <Static key={renderEpoch} items={finalized}>
        {(block, index) => (
          <BlockView key={index} block={block} verbose={props.verbose} expandable={false} />
        )}
      </Static>
      {live.map((block, i) => (
        <BlockView key={liveKey(block, splitAt + i)} block={block} verbose={props.verbose} now={props.tick} />
      ))}
      {reasoningText !== "" && (
        <Box marginLeft={2}>
          <Text color={c("foregroundSubtle")} italic wrap="truncate-end">
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

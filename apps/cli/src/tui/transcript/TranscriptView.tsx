import { Static, Text } from "ink";
import { useStore } from "zustand";
import type { UiStore } from "@kcode/ui";
import { BlockView, TodoPanel } from "./Transcript.js";

/**
 * 转写区（N2-3 外迁）：Static 架构——已完成块一次性推进 scrollback（不再重绘，长会话不整帧重印）；
 * 活跃帧只保留尾部（运行中的工具块 + 流式文本 + 思考行 + Todo）。
 * 订阅 ui store（transcript slice），App 不再经手转写状态。
 */
export function TranscriptView(props: { ui: UiStore; verbose: boolean; tick: number }) {
  const blocks = useStore(props.ui, (s) => s.blocks);
  const streamText = useStore(props.ui, (s) => s.streamText);
  const reasoningText = useStore(props.ui, (s) => s.reasoningText);
  const todos = useStore(props.ui, (s) => s.todos);

  const runningTail: typeof blocks = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === "tool" && b.status === "running") {
      runningTail.unshift(b);
    } else {
      break;
    }
  }
  const finalized = blocks.slice(0, blocks.length - runningTail.length);

  return (
    <>
      <Static items={finalized}>
        {(block, index) => <BlockView key={index} block={block} verbose={props.verbose} />}
      </Static>
      {runningTail.map((b, i) => (
        <BlockView key={`live-${i}`} block={b} verbose={props.verbose} now={props.tick} />
      ))}
      {reasoningText !== "" && (
        <Text dimColor italic wrap="truncate-end">
          ✻ {reasoningText.split("\n").at(-1)?.slice(-100) ?? ""}
        </Text>
      )}
      {streamText !== "" && <Text>{streamText}</Text>}
      {todos.length > 0 && <TodoPanel todos={todos} />}
    </>
  );
}

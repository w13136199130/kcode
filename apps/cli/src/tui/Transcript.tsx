import { Box, Text } from "ink";

export type Block =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      callId: string;
      tool: string;
      argsPreview: string;
      status: "running" | "done" | "failed";
      summary?: string;
    }
  | { kind: "info"; text: string };

/** 会话转写区：完成块 + 流式文本（P1-5 Ink TUI） */
export function Transcript(props: { blocks: Block[]; streamText: string }) {
  return (
    <Box flexDirection="column">
      {props.blocks.map((block, i) => {
        if (block.kind === "user") {
          return (
            <Text key={i} color="green">
              {"> "}
              {block.text}
            </Text>
          );
        }
        if (block.kind === "assistant") {
          return (
            <Text key={i}>{block.text}</Text>
          );
        }
        if (block.kind === "info") {
          return (
            <Text key={i} dimColor>
              {block.text}
            </Text>
          );
        }
        const icon = block.status === "running" ? "⚡" : block.status === "done" ? "✓" : "✗";
        const color = block.status === "failed" ? "red" : block.status === "running" ? "yellow" : "blue";
        return (
          <Box key={i} flexDirection="column">
            <Text color={color}>
              {icon} {block.tool} {block.argsPreview}
            </Text>
            {block.summary !== undefined && block.summary !== "" && (
              <Text dimColor>  {block.summary}</Text>
            )}
          </Box>
        );
      })}
      {props.streamText !== "" && <Text color="white">{props.streamText}</Text>}
    </Box>
  );
}

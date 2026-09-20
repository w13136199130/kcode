import { Box, Text } from "ink";
import type { TodoItem } from "@kcode/contracts";

export type Block =
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

/** verbose 态工具输出最多渲染行数 */
const VERBOSE_TOOL_LINES = 12;

/** 会话转写区：完成块 + 流式文本（P1-5 Ink TUI）；now 驱动 running 态动态耗时；verbose 展开思考/输出 */
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
        if (block.kind === "reasoning") {
          const timing = block.ms !== undefined ? ` ${formatMs(block.ms)}` : "";
          if (props.verbose === true) {
            // 展开态：思考全文（多行，灰色斜体）
            const lines = block.text.split("\n").slice(0, 30);
            return (
              <Box key={i} flexDirection="column">
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
          // 折叠态：单行摘要（完成后的思考不再占屏）
          const preview = block.text.split("\n")[0]?.slice(0, 60) ?? "";
          return (
            <Text key={i} dimColor italic>
              ✻ 思考{timing} · {preview}
              {block.text.length > 60 ? `…（共 ${block.text.length} 字）` : ""}
            </Text>
          );
        }
        if (block.kind === "info") {
          const color = block.tone === "ok" ? "green" : block.tone === "deny" ? "red" : block.tone === "warn" ? "yellow" : undefined;
          return (
            <Text key={i} color={color} dimColor={block.tone === undefined}>
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
          <Box key={i} flexDirection="column">
            <Text color={color}>
              {icon} {block.tool} {block.argsPreview}
              {timing}
            </Text>
            {block.summary !== undefined && block.summary !== "" && block.output === undefined && (
              <Text dimColor>  {block.summary}</Text>
            )}
            {props.verbose === true && block.output !== undefined && block.output !== "" && (
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
            )}
          </Box>
        );
      })}
      {props.reasoningText !== undefined && props.reasoningText !== "" && (
        <Text dimColor italic wrap="truncate-end">
          ✻ {props.reasoningText.split("\n").at(-1)?.slice(-100) ?? ""}
        </Text>
      )}
      {props.streamText !== "" && <Text color="white">{props.streamText}</Text>}
    </Box>
  );
}

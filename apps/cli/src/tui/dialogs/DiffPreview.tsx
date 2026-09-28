import type { AskPreviewPayload } from "@kcode/contracts";
import { Box, Text } from "ink";
import { truncateVisual } from "../terminal/width.js";
import { c } from "../theme/theme.js";

/** diff 预览行渲染：- 红 / + 绿 / 上下文 dim；行数超限截断 */
const PREVIEW_MAX_LINES = 20;

export function DiffPreview(props: { preview: AskPreviewPayload }) {
  const lines = props.preview.diff.split("\n");
  const shown = lines.slice(0, PREVIEW_MAX_LINES);
  return (
    <Box flexDirection="column">
      {props.preview.path !== undefined && (
        <Text color={c("brand")} bold>
          {"  "}
          {props.preview.path}
        </Text>
      )}
      {shown.map((line, i) => (
        <Text
          key={i}
          color={line.startsWith("+") ? c("success") : line.startsWith("-") ? c("destructive") : undefined}
          dimColor={!line.startsWith("+") && !line.startsWith("-")}
        >
          {"  "}
          {truncateVisual(line, 120)}
        </Text>
      ))}
      {lines.length > PREVIEW_MAX_LINES && (
        <Text dimColor>
          {"  "}…（共 {lines.length} 行，已截断）
        </Text>
      )}
    </Box>
  );
}

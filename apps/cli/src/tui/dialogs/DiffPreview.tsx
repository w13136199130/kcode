import type { AskPreviewPayload } from "@kcode/contracts";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { c } from "../theme/theme.js";
import { stripEscapes } from "../terminal/sanitize.js";

/** 每页行数：完整内容可翻页查看，不再静默截断 */
const PAGE_LINES = 25;

export function DiffPreview(props: { preview: AskPreviewPayload }) {
  // 3-26：文件内容同样可能带 ESC（恶意仓库/构建产物），渲染前剥离
  const lines = stripEscapes(props.preview.diff).split("\n");
  const [offset, setOffset] = useState(0);
  const maxOffset = Math.max(0, lines.length - PAGE_LINES);
  useInput((_ch, key) => {
    if (key.pageDown) {
      setOffset((o) => Math.min(maxOffset, o + PAGE_LINES));
      return;
    }
    if (key.pageUp) {
      setOffset((o) => Math.max(0, o - PAGE_LINES));
    }
  });
  const shown = lines.slice(offset, offset + PAGE_LINES);
  return (
    <Box flexDirection="column">
      {props.preview.path !== undefined && (
        <Text color={c("brand")} bold>
          {"  "}
          {stripEscapes(props.preview.path)}
        </Text>
      )}
      {shown.map((line, i) => (
        <Text
          key={i}
          color={line.startsWith("+") ? c("success") : line.startsWith("-") ? c("destructive") : undefined}
          dimColor={!line.startsWith("+") && !line.startsWith("-")}
          wrap="wrap"
        >
          {"  "}
          {line}
        </Text>
      ))}
      <Text dimColor>
        {"  "}
        {lines.length > PAGE_LINES
          ? `第 ${offset + 1}-${Math.min(lines.length, offset + PAGE_LINES)} 行 / 共 ${lines.length} 行 · PgUp/PgDn 翻页`
          : `共 ${lines.length} 行`}
      </Text>
    </Box>
  );
}

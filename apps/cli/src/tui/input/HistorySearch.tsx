import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "zustand";
import type { UiStore } from "@kcode/ui";
import { truncateVisual } from "../terminal/width.js";
import { c } from "../theme/theme.js";

/**
 * 历史搜索覆盖层（N3C-4⑥ Ctrl+R）：跨会话输入历史的增量过滤检索
 * （历史持久化于 ~/.kcode/cli/history.json，InputArea 传入最近 50 条）。
 * 键位自持：本组件挂载期间输入区已被顶替，字符/退格编辑查询、↑↓ 选择、
 * Enter 回填到输入框、Esc 关闭——与浏览器面板同型的覆盖层交互。
 */

/** 最多显示的匹配条数（最近优先） */
const MAX_MATCHES = 10;

export function HistorySearch(props: {
  ui: UiStore;
  history: readonly string[];
  /** 选定回填（App 的 setInput 通道） */
  onPick(text: string): void;
}) {
  const open = useStore(props.ui, (s) => s.historySearchOpen);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  // 最近优先：history 按时间升序存储，倒序后过滤（大小写不敏感子串）
  const reversed = [...props.history].reverse();
  const lower = query.toLowerCase();
  const matches = (lower === "" ? reversed : reversed.filter((h) => h.toLowerCase().includes(lower))).slice(
    0,
    MAX_MATCHES,
  );

  useInput(
    (ch, key) => {
      if (key.escape) {
        props.ui.getState().closeHistorySearch();
        return;
      }
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => Math.min(Math.max(0, matches.length - 1), c + 1));
        return;
      }
      if (key.return) {
        const picked = matches[cursor];
        if (picked !== undefined) {
          props.ui.getState().closeHistorySearch();
          props.onPick(picked);
        }
        return;
      }
      if (key.ctrl) {
        return; // 其余组合键不编辑查询
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        setCursor(0);
        return;
      }
      if (ch !== "") {
        setQuery((q) => q + ch);
        setCursor(0);
      }
    },
    { isActive: open },
  );

  if (!open) {
    return null;
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={c("brand")} paddingX={1}>
      <Text dimColor>
        搜索输入历史{query === "" ? "" : `：${query}`} · 匹配 {matches.length} 条 · ↑↓ 选择 · Enter 回填 · Esc 关闭
      </Text>
      {matches.length === 0 ? (
        <Text dimColor>（无匹配——换个关键词试试）</Text>
      ) : (
        matches.map((h, i) => (
          <Text key={`${i}-${h}`} color={i === cursor ? c("brand") : undefined} bold={i === cursor}>
            {i === cursor ? "❯ " : "  "}
            {truncateVisual(h, 80)}
          </Text>
        ))
      )}
    </Box>
  );
}

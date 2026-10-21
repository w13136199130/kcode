import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { c, glyph } from "../theme/theme.js";
import { stripEscapes } from "../terminal/sanitize.js";
import { truncateVisual } from "../terminal/width.js";

/** 3-36：命令面板动作（命令/键动作统一形状） */
export interface PaletteAction {
  id: string;
  /** 面板展示名（命令通常是 /name） */
  label: string;
  description: string;
  hint?: string;
  kind: "命令" | "动作";
  run(): void;
}

const WINDOW = 8;
/** 最近使用（进程内；命令面板不持久化，避免污染配置文件） */
const RECENT: string[] = [];
function remember(id: string): void {
  const index = RECENT.indexOf(id);
  if (index !== -1) RECENT.splice(index, 1);
  RECENT.unshift(id);
  if (RECENT.length > 20) RECENT.length = 20;
}

/** 模糊子序列匹配：返回分数（越大越好），不匹配返回 null */
export function fuzzyScore(query: string, action: PaletteAction): number | null {
  const q = query.trim().toLowerCase();
  if (q === "") return 0;
  const hay = `${action.label} ${action.description} ${action.hint ?? ""}`.toLowerCase();
  let at = 0;
  let score = 0;
  let last = -1;
  for (const ch of q) {
    const found = hay.indexOf(ch, at);
    if (found === -1) return null;
    score += 10 - Math.min(5, found - last - 1);
    if (found === 0 || hay[found - 1] === " " || hay[found - 1] === "/") score += 4;
    last = found;
    at = found + 1;
  }
  if (hay.startsWith(q)) score += 12;
  return score;
}

/**
 * 3-36：Ctrl+K 命令面板。
 * 覆盖层形态（顶替输入区），动作注册表由 InputArea 组装；本组件只负责过滤/选择/执行。
 */
export function CommandPalette(props: { actions: readonly PaletteAction[]; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const filtered = useMemo(() => {
    return props.actions
      .map((action) => ({ action, score: fuzzyScore(query, action) }))
      .filter((x): x is { action: PaletteAction; score: number } => x.score !== null)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const ra = RECENT.indexOf(a.action.id);
        const rb = RECENT.indexOf(b.action.id);
        if (ra !== -1 || rb !== -1) return (ra === -1 ? 999 : ra) - (rb === -1 ? 999 : rb);
        return a.action.label.localeCompare(b.action.label);
      })
      .map((x) => x.action);
  }, [props.actions, query]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  const selected = filtered[Math.min(cursor, Math.max(0, filtered.length - 1))];

  useInput((ch, key) => {
    if (key.escape || (key.ctrl && ch === "k")) {
      props.onClose();
      return;
    }
    if (key.upArrow) {
      setCursor((value) => (filtered.length === 0 ? 0 : (value - 1 + filtered.length) % filtered.length));
      return;
    }
    if (key.downArrow) {
      setCursor((value) => (filtered.length === 0 ? 0 : (value + 1) % filtered.length));
      return;
    }
    if (key.return) {
      if (selected !== undefined) {
        remember(selected.id);
        props.onClose();
        selected.run();
      }
      return;
    }
    if (key.backspace || key.delete) {
      if (query === "") props.onClose();
      else setQuery((value) => value.slice(0, -1));
      return;
    }
    if (key.ctrl && ch === "u") {
      setQuery("");
      return;
    }
    if (key.ctrl || key.meta || key.tab) return;
    if (typeof ch === "string" && ch !== "") {
      setQuery((value) => value + ch);
    }
  });

  const start = Math.max(0, Math.min(cursor - Math.floor(WINDOW / 2), filtered.length - WINDOW));
  const shown = filtered.slice(start, start + WINDOW);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={c("brand")} paddingX={1}>
      <Text bold color={c("brand")}>
        {`${glyph("⌘", ">")} 命令面板`}
      </Text>
      <Text color={c("accent")}>{`❯ ${stripEscapes(query)}█`}</Text>
      {filtered.length === 0 ? (
        <Text dimColor>（无匹配）</Text>
      ) : (
        shown.map((action, index) => {
          const absolute = start + index;
          const active = absolute === cursor;
          return (
            <Text key={action.id} color={active ? c("brand") : undefined} wrap="truncate-end">
              {active ? "❯ " : "  "}
              <Text bold={active}>{action.label}</Text>
              <Text color={c("foregroundSubtle")}>{`  ${action.kind}`}</Text>
              <Text color={c("foregroundSubtle")}>
                {`  ${truncateVisual(stripEscapes(action.description), 72)}`}
              </Text>
            </Text>
          );
        })
      )}
      <Text color={c("foregroundSubtle")} wrap="truncate-end">
        {`↑↓ 选择 · Enter 执行 · Esc 关闭${filtered.length > WINDOW ? ` · ${cursor + 1}/${filtered.length}` : ""}`}
      </Text>
    </Box>
  );
}

import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "zustand";
import type { Block, UiStore } from "@kcode/ui";
import { truncateVisual } from "../terminal/width.js";
import { linkifyStructuredPaths } from "../terminal/links.js";
import { stripEscapes } from "../terminal/sanitize.js";
import { copyTextToClipboard } from "../terminal/clipboard-text.js";
import { c, glyph } from "../theme/theme.js";

/**
 * 工具卡片浏览器（N3C-4② + 3-22）：覆盖层面板，从 store 的 blocks 渲染历史工具调用。
 * - ↑↓ 选卡、Enter 展开/收起；列表键位在本组件（3-22 起明细需要全文窗口），
 *   Ctrl+B/Esc 关闭仍由 keybinds 统一处理；
 * - 展开后：PgUp/PgDn 翻页、/ 搜索、c 复制、g/G 顶部/末尾、Esc 收起；
 * - 失败输出默认停在末尾（测试/构建错误都在尾部），并给出会话 JSONL 路径。
 * 为什么是覆盖层而不是改 Static：转写区已完成块推进 scrollback 后不再重绘，
 * "逐卡展开"只能在 Static 之外的数据视图上实现。
 */

/** 列表窗口大小：面板最多占屏 10 行（长会话只看光标附近） */
const WINDOW = 10;
/** 3-22 详情每页行数 */
const PAGE_LINES = 18;

type ToolBlock = Extract<Block, { kind: "tool" }>;

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function ToolBrowser(props: {
  ui: UiStore;
  /** 3-22：会话 JSONL 绝对路径（详情给出完整事件位置） */
  jsonlPath?: string;
  /** 3-22：按 callId 取完整输出（块内只存 2k 预览） */
  loadOutput?: (callId: string) => Promise<string | null>;
  /** 3-22：复制实现（测试注入；缺省走系统剪贴板） */
  copy?: (text: string) => boolean;
}) {
  const blocks = useStore(props.ui, (s) => s.blocks);
  const browser = useStore(props.ui, (s) => s.toolBrowser);
  const tools = blocks.filter((b): b is ToolBlock => b.kind === "tool");

  const cursor = Math.min(browser.cursor, Math.max(0, tools.length - 1));
  const selected = tools[cursor];
  const expanded = selected !== undefined && browser.expandedCallId === selected.callId ? selected : undefined;

  // 详情态（3-22）：全文按需加载；滚动/搜索是面板局部态（行数依赖加载结果，不放进全局 store）
  const [fullText, setFullText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [followTail, setFollowTail] = useState(false);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const loadRef = useRef(props.loadOutput);
  loadRef.current = props.loadOutput;

  const preview = expanded === undefined ? "" : (expanded.output ?? expanded.summary ?? "");
  const running = expanded?.status === "running";
  const detailText = running ? preview : (fullText ?? preview);

  // 展开/切换卡片时复位窗口；块内预览被 2k 截断则按 callId 从 JSONL 取全文
  useEffect(() => {
    setFullText(null);
    setLoading(false);
    setOffset(0);
    setSearch("");
    setDraft(null);
    if (expanded === undefined) {
      setFollowTail(false);
      return;
    }
    setFollowTail(expanded.status === "failed");
    if (expanded.status === "running") {
      return;
    }
    const outputLength = expanded.output?.length ?? 0;
    if (outputLength < 2000 || loadRef.current === undefined) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    void loadRef
      .current(expanded.callId)
      .then((text) => {
        if (!cancelled && text !== null) {
          setFullText(text);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // 只随卡片身份/终态变化重载；加载函数每次渲染都是新引用，经 ref 取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded?.callId, expanded?.status]);

  const baseLines = detailText === "" ? [] : detailText.split("\n");
  const query = search.trim().toLowerCase();
  const rows =
    query === ""
      ? baseLines.map((text, i) => ({ no: i + 1, text }))
      : baseLines.map((text, i) => ({ no: i + 1, text })).filter((row) => row.text.toLowerCase().includes(query));
  const maxOffset = Math.max(0, rows.length - PAGE_LINES);
  const shownOffset = followTail ? maxOffset : Math.min(offset, maxOffset);
  const visible = rows.slice(shownOffset, shownOffset + PAGE_LINES);
  const numberWidth = String(rows[rows.length - 1]?.no ?? 1).length;

  const scrollTo = (next: number): void => {
    setFollowTail(false);
    setOffset(Math.max(0, Math.min(maxOffset, next)));
  };

  const copyDetail = (): void => {
    // 复制也走剥离：粘贴到编辑器/聊天框的仍是纯文本，不携带可执行控制序列
    const text = stripEscapes(detailText);
    if (text === "") {
      props.ui.getState().pushBlock({ kind: "info", tone: "warn", text: "（没有可复制的输出）" });
      return;
    }
    let ok = false;
    try {
      ok = (props.copy ?? copyTextToClipboard)(text);
    } catch {
      ok = false;
    }
    props.ui.getState().pushBlock({
      kind: "info",
      tone: ok ? "ok" : "warn",
      text: ok
        ? `📋 已复制 ${baseLines.length} 行输出（${expanded?.tool ?? "tool"} · ${expanded?.callId ?? ""}）`
        : "✗ 复制失败：当前环境没有可用的剪贴板命令（Windows 需 PowerShell；Linux 需 wl-copy/xclip/xsel）",
    });
  };

  useInput(
    (ch, key) => {
      // 搜索输入态：全部按键归输入行（Esc 取消、回车应用）
      if (draft !== null) {
        if (key.escape) {
          setDraft(null);
          return;
        }
        if (key.return) {
          setSearch(draft.trim());
          setOffset(0);
          setFollowTail(false);
          setDraft(null);
          return;
        }
        if (key.backspace || key.delete) {
          setDraft(draft.slice(0, -1));
          return;
        }
        if (!key.ctrl && !key.tab && ch !== "" && !key.escape) {
          setDraft(draft + ch);
        }
        return;
      }
      if (expanded === undefined) {
        if (key.upArrow || ch === "k") {
          props.ui.getState().moveToolCursor(-1);
          return;
        }
        if (key.downArrow || ch === "j") {
          props.ui.getState().moveToolCursor(1);
          return;
        }
        if (key.return) {
          props.ui.getState().toggleToolDetail();
        }
        return;
      }
      if (key.escape) {
        // 详情收起（keybinds 在 expanded 时让行，不会同时关面板）
        props.ui.getState().toggleToolDetail();
        return;
      }
      if (key.pageDown) {
        scrollTo(shownOffset + PAGE_LINES);
        return;
      }
      if (key.pageUp) {
        scrollTo(shownOffset - PAGE_LINES);
        return;
      }
      if (key.upArrow || ch === "k") {
        scrollTo(shownOffset - 1);
        return;
      }
      if (key.downArrow || ch === "j") {
        scrollTo(shownOffset + 1);
        return;
      }
      if (ch === "g") {
        scrollTo(0);
        return;
      }
      if (ch === "G") {
        setFollowTail(true);
        return;
      }
      if (ch === "/") {
        setDraft(search);
        return;
      }
      if (ch === "c") {
        copyDetail();
      }
    },
    { isActive: browser.open },
  );

  if (tools.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={c("brand")} paddingX={1}>
        <Text dimColor>本会话还没有工具调用（Ctrl+B 或 Esc 关闭）</Text>
      </Box>
    );
  }

  // 窗口以光标为中心 clamp 到列表两端
  const start = Math.max(0, Math.min(cursor - Math.floor(WINDOW / 2), tools.length - WINDOW));
  const view = tools.slice(start, start + WINDOW);
  const failedTail = expanded?.status === "failed" && followTail && query === "";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={c("brand")} paddingX={1}>
      <Text dimColor>
        工具调用 {cursor + 1}/{tools.length}
        {start > 0 ? " ↑更多" : ""}
        {start + view.length < tools.length ? " ↓更多" : ""} · ↑↓ 选择 · Enter 展开详情 · Ctrl+B/Esc 关闭
      </Text>
      {view.map((b, i) => {
        const index = start + i;
        const isSelected = index === cursor;
        const icon =
          b.status === "running" ? glyph("⚡", "*") : b.status === "failed" ? glyph("✗", "x") : glyph("✓", "+");
        const color = b.status === "failed" ? c("destructive") : b.status === "running" ? c("info") : c("success");
        return (
          <Box key={b.callId} flexDirection="column">
            <Text color={isSelected ? c("brand") : color} bold={isSelected}>
              {isSelected ? "❯ " : "  "}
              {icon} {stripEscapes(b.tool)} <Text dimColor>{truncateVisual(stripEscapes(b.argsPreview), 60)}</Text>
              {b.durationMs !== undefined ? ` (${formatMs(b.durationMs)})` : ""}
            </Text>
          </Box>
        );
      })}
      {expanded !== undefined && (
        <Box flexDirection="column" marginLeft={2}>
          <Text dimColor>
            {"  "}
            {rows.length === 0
              ? query !== ""
                ? "匹配 0 行"
                : "（无输出）"
              : `第 ${shownOffset + 1}-${Math.min(rows.length, shownOffset + PAGE_LINES)} / 共 ${rows.length} 行`}
            {query !== "" ? ` · 搜索「${search.trim()}」命中 ${rows.length} 行` : ""}
            {failedTail ? " · 失败输出默认末尾（g 顶部 / G 末尾）" : ""}
            {loading ? " · 读取完整输出…" : ""}
          </Text>
          {draft !== null && (
            <Text color={c("accent")}>{`  /${draft}█  （回车应用 · Esc 取消；空查询清除）`}</Text>
          )}
          {visible.length === 0 && query !== "" ? (
            <Text dimColor>{"  （没有匹配行——/ 修改搜索，或空回车清除）"}</Text>
          ) : (
            visible.map((row) => (
              <Text key={row.no} dimColor wrap="truncate-end">
                {"  "}
                {String(row.no).padStart(numberWidth)} │ {truncateVisual(linkifyStructuredPaths(stripEscapes(row.text)), 116)}
              </Text>
            ))
          )}
          <Text dimColor>{"  "}PgUp/PgDn 翻页 · / 搜索 · c 复制 · g/G 顶部/末尾 · Esc 收起</Text>
          <Text dimColor wrap="truncate-end">
            {"  "}完整事件：{stripEscapes(props.jsonlPath ?? "会话 JSONL")}（callId={expanded.callId}）
          </Text>
        </Box>
      )}
    </Box>
  );
}

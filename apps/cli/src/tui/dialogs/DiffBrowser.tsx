import { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useServices } from "@kcode/ui";
import type { CliServices } from "../state/services.js";
import type { DiffBrowserState, DiffChange } from "../state/interactions.js";
import { c } from "../theme/theme.js";
import {
  diffStats,
  parseDiff,
  relativePath,
  toHunks,
  type DiffHunk,
  type DiffLineKind,
} from "./diff-model.js";

/** 文件视图每页行数：与 DiffPreview 一致，PgUp/PgDn 翻页 */
const PAGE_LINES = 20;

type Row = { kind: "header" | DiffLineKind; text: string };

function rowsOf(hunks: readonly DiffHunk[]): Row[] {
  const rows: Row[] = [];
  for (const hunk of hunks) {
    rows.push({ kind: "header", text: hunk.header });
    for (const line of hunk.lines) {
      rows.push({ kind: line.kind, text: line.text });
    }
  }
  return rows;
}

function lineColor(kind: Row["kind"]): string | undefined {
  if (kind === "+") return c("success");
  if (kind === "-") return c("destructive");
  if (kind === "header") return c("brand");
  if (kind === "!") return c("warning");
  return undefined;
}

/**
 * 3-23 `/diff` 审查面板：
 * 文件列表（+/- 与 hunk 数）→ 单文件 hunk 视图（分页）→ 逐文件回退（checkpoint 前像）。
 * 回退是不可逆的磁盘写入，必须二次确认；运行中由 App 拒绝打开。
 */
export function DiffBrowserPanel(props: { state: DiffBrowserState; cwd: string }) {
  const dialogs = useServices<CliServices>().dialogs;
  const { changes } = props.state;
  const [selected, setSelected] = useState(() =>
    Math.max(0, changes.findIndex((change) => change.path === props.state.focusPath)),
  );
  const [viewPath, setViewPath] = useState<string | null>(props.state.focusPath ?? null);
  const [offset, setOffset] = useState(0);
  const [confirmPath, setConfirmPath] = useState<string | null>(null);

  const index = Math.min(selected, Math.max(0, changes.length - 1));
  const current: DiffChange | undefined = changes[index];
  // 回退后清单会刷新：当前文件被移除时自动退回列表（不在渲染期 setState）
  const file = viewPath === null ? undefined : changes.find((change) => change.path === viewPath);
  const hunks = useMemo(() => (file === undefined ? [] : toHunks(file.diff)), [file]);
  const rows = useMemo(() => rowsOf(hunks), [hunks]);
  // renderDiff 超上限会截断并留提示行：面板要明说"看到的不是全部"，避免误判改动范围
  const truncated = useMemo(
    () => file !== undefined && parseDiff(file.diff).some((line) => line.kind === "!"),
    [file],
  );
  const maxOffset = Math.max(0, rows.length - PAGE_LINES);
  const summary = useMemo(
    () => new Map(changes.map((change) => [change.path, diffStats(change.diff)])),
    [changes],
  );
  const shownOffset = Math.min(offset, maxOffset);
  const confirmTarget =
    confirmPath === null ? undefined : changes.find((change) => change.path === confirmPath);

  const revert = (change: DiffChange): void => {
    const rel = relativePath(change.path, props.cwd);
    void (async () => {
      const result = await dialogs.revertFile(change.path);
      if (typeof result === "string") {
        dialogs.pushBlock({ kind: "info", tone: "warn", text: `✗ 回退失败：${result}` });
        return;
      }
      dialogs.pushBlock({
        kind: "info",
        tone: "ok",
        text:
          result.remaining === 0
            ? `⏪ 已回退 ${rel}——本会话的文件改动已全部撤回`
            : `⏪ 已回退 ${rel}（剩余 ${result.remaining} 个文件改动，/diff 继续审查）`,
      });
    })();
  };

  useInput((ch, key) => {
    if (confirmTarget !== undefined) {
      if (ch.toLowerCase() === "y") {
        setConfirmPath(null);
        revert(confirmTarget);
        return;
      }
      if (ch.toLowerCase() === "n" || key.escape) {
        setConfirmPath(null);
      }
      return;
    }
    if (file !== undefined) {
      if (key.escape) {
        setViewPath(null);
        setOffset(0);
        return;
      }
      if (key.pageDown) {
        setOffset(Math.min(maxOffset, shownOffset + PAGE_LINES));
        return;
      }
      if (key.pageUp) {
        setOffset(Math.max(0, shownOffset - PAGE_LINES));
        return;
      }
      if (key.downArrow || ch === "j") {
        setOffset(Math.min(maxOffset, shownOffset + 1));
        return;
      }
      if (key.upArrow || ch === "k") {
        setOffset(Math.max(0, shownOffset - 1));
        return;
      }
      if (ch === "g") {
        setOffset(0);
        return;
      }
      if (ch === "G") {
        setOffset(maxOffset);
        return;
      }
      if (ch.toLowerCase() === "r") {
        setConfirmPath(file.path);
      }
      return;
    }
    if (key.escape) {
      dialogs.setDiffBrowser(null);
      return;
    }
    if (key.downArrow || ch === "j") {
      setSelected(Math.min(changes.length - 1, index + 1));
      return;
    }
    if (key.upArrow || ch === "k") {
      setSelected(Math.max(0, index - 1));
      return;
    }
    if (key.return) {
      if (current !== undefined) {
        setViewPath(current.path);
        setOffset(0);
      }
      return;
    }
    if (ch.toLowerCase() === "r" && current !== undefined) {
      setConfirmPath(current.path);
    }
  });

  if (confirmTarget !== undefined) {
    return (
      <Box flexDirection="column">
        <Text color={c("warning")} bold>
          ⚠ 回退 {relativePath(confirmTarget.path, props.cwd)} 到本会话开始前？
        </Text>
        <Text> 该文件本会话的全部改动都将撤回（覆盖当前磁盘内容，不可撤销）。</Text>
        <Text dimColor> y 确认回退 · n/Esc 取消</Text>
      </Box>
    );
  }

  if (file !== undefined) {
    return (
      <Box flexDirection="column">
        <Text color={c("accent")} bold>
          📝 {relativePath(file.path, props.cwd)}
          {file.existed ? "" : "（新建）"} · +{summary.get(file.path)?.additions ?? 0} -
          {summary.get(file.path)?.deletions ?? 0} · {hunks.length} hunk（Esc 返回列表）
        </Text>
        {truncated && (
          <Text color={c("warning")}> ⚠ 改动过大，diff 已截断（仅显示前 400 行）——回退仍按整个文件生效</Text>
        )}
        {rows.length === 0 ? (
          <Text dimColor> （无差异内容——回退后本文件已回到检查点基线）</Text>
        ) : (
          rows.slice(shownOffset, shownOffset + PAGE_LINES).map((row, i) => (
            <Text
              key={shownOffset + i}
              color={lineColor(row.kind)}
              bold={row.kind === "header"}
              dimColor={row.kind === " " || row.kind === "!"}
              wrap="wrap"
            >
              {"  "}
              {row.kind === "header" || row.kind === "!" ? row.text : `${row.kind}${row.text}`}
            </Text>
          ))
        )}
        <Text dimColor>
          {"  "}
          {rows.length === 0
            ? "共 0 行"
            : `第 ${shownOffset + 1}-${Math.min(rows.length, shownOffset + PAGE_LINES)} 行 / 共 ${rows.length} 行`}
          {" · PgUp/PgDn 翻页 · r 回退此文件 · Esc 返回"}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={c("accent")} bold>
        📝 本会话改动 {changes.length} 个文件
        {props.state.query !== undefined ? `（筛选「${props.state.query}」）` : ""}
        （检查点基线 → 当前磁盘 · Esc 关闭）
      </Text>
      {changes.map((change, i) => {
        const stats = summary.get(change.path);
        return (
          <Text key={change.path} color={i === index ? c("brand") : undefined} bold={i === index}>
            {i === index ? "❯" : " "} {relativePath(change.path, props.cwd)}
            {change.existed ? "" : "（新建）"}{" "}
            <Text color={c("success")}>+{stats?.additions ?? 0}</Text>{" "}
            <Text color={c("destructive")}>-{stats?.deletions ?? 0}</Text>
            {` · ${stats?.hunks ?? 0} hunk`}
          </Text>
        );
      })}
      <Text dimColor> ↑↓ 选择 · 回车查看 diff · r 回退此文件 · Esc 关闭</Text>
    </Box>
  );
}

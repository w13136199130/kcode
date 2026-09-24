import { readFile } from "node:fs/promises";
import type { ToolContext } from "@kcode/contracts";
import { resolveInCtx } from "./paths.js";

/** ask 确认时附带的变更预览：path + 预渲染 diff（- 删 / + 增行前缀） */
export interface AskPreview {
  path?: string;
  diff: string;
}

/** 预览 diff 的行数上限：超出截断为提示行，避免刷屏 */
const MAX_DIFF_LINES = 40;

/**
 * 为写/编辑类工具构建变更预览（组合层在推送 ask 前调用）：
 * - edit：oldString/newString 直接对拍；
 * - write：与磁盘旧内容做行级替换对比（新文件整体为新增）；
 * 其余工具返回 undefined（args 摘要即预览）。
 */
export async function buildAskPreview(
  tool: string,
  args: unknown,
  ctx: ToolContext,
): Promise<AskPreview | undefined> {
  if (tool === "edit") {
    const parsed = args as { path?: unknown; oldString?: unknown; newString?: unknown };
    if (
      typeof parsed.path !== "string" ||
      typeof parsed.oldString !== "string" ||
      typeof parsed.newString !== "string"
    ) {
      return undefined;
    }
    return {
      path: parsed.path,
      diff: renderDiff(parsed.oldString.split(/\r?\n/), parsed.newString.split(/\r?\n/)),
    };
  }
  if (tool === "write") {
    const parsed = args as { path?: unknown; content?: unknown };
    if (typeof parsed.path !== "string" || typeof parsed.content !== "string") {
      return undefined;
    }
    const abs = resolveInCtx(parsed.path, ctx);
    let oldText: string | null = null;
    try {
      oldText = await readFile(abs, "utf8");
    } catch {
      oldText = null; // 新文件
    }
    const oldLines = oldText === null ? [] : oldText.split(/\r?\n/);
    return {
      path: parsed.path,
      diff:
        oldText === null
          ? renderDiff([], parsed.content.split(/\r?\n/))
          : renderDiff(oldLines, parsed.content.split(/\r?\n/)),
    };
  }
  return undefined;
}

/**
 * 行级 diff（LCS 最长公共子序列）：小片段对拍够用，
 * 超过上限截断——预览用途，不追求 Myers 最优性。
 */
export function renderDiff(oldLines: string[], newLines: string[]): string {
  const rows = oldLines.length;
  const cols = newLines.length;
  // LCS DP 表；行数被上限兜底（MAX_DIFF_LINES*2 以内），不会失控
  const cappedOld = oldLines.slice(0, MAX_DIFF_LINES * 2);
  const cappedNew = newLines.slice(0, MAX_DIFF_LINES * 2);
  if (cappedOld.length !== rows || cappedNew.length !== cols) {
    return truncateLines([
      ...cappedOld.map((l) => `-${l}`),
      ...cappedNew.map((l) => `+${l}`),
    ]);
  }
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    Array.from({ length: cols + 1 }, () => 0),
  );
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i]![j]! =
        oldLines[i] === newLines[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      out.push(` ${oldLines[i]}`);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push(`-${oldLines[i]}`);
      i++;
    } else {
      out.push(`+${newLines[j]}`);
      j++;
    }
  }
  while (i < rows) {
    out.push(`-${oldLines[i]}`);
    i++;
  }
  while (j < cols) {
    out.push(`+${newLines[j]}`);
    j++;
  }
  return truncateLines(out);
}

function truncateLines(lines: string[]): string {
  if (lines.length <= MAX_DIFF_LINES) {
    return lines.join("\n");
  }
  return `${lines.slice(0, MAX_DIFF_LINES).join("\n")}\n…（其余 ${lines.length - MAX_DIFF_LINES} 行省略）`;
}

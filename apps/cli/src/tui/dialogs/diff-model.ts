import { isAbsolute, relative, sep } from "node:path";

/**
 * 3-23 /diff 的纯数据层：把检查点 diff（整篇 LCS，行首 ` `/`+`/`-`）
 * 解析成带行号的 hunk，供面板分页/统计——渲染与文件读取都留在调用方。
 */

export type DiffLineKind = " " | "+" | "-" | "!";

export interface DiffLine {
  kind: DiffLineKind;
  /** 去掉行首标记后的正文（`!` 为截断提示原文） */
  text: string;
  /** 旧文件行号（上下文/删除行） */
  oldNo?: number;
  /** 新文件行号（上下文/新增行） */
  newNo?: number;
}

export interface DiffHunk {
  /** 统一 diff 头：@@ -旧起点,旧行数 +新起点,新行数 @@ */
  header: string;
  lines: DiffLine[];
}

export interface DiffStats {
  additions: number;
  deletions: number;
  hunks: number;
}

/**
 * 解析统一 diff 行。renderDiff 保证正文行带前缀；不以 ` `/`+`-` 开头的行
 * （如“其余 N 行省略”）记为 `!` 提示，不参与行号与 hunk 计数。
 */
export function parseDiff(diff: string): DiffLine[] {
  if (diff === "") {
    return [];
  }
  const lines: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+")) {
      lines.push({ kind: "+", text: raw.slice(1), newNo });
      newNo++;
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "-", text: raw.slice(1), oldNo });
      oldNo++;
    } else if (raw.startsWith(" ")) {
      lines.push({ kind: " ", text: raw.slice(1), oldNo, newNo });
      oldNo++;
      newNo++;
    } else {
      lines.push({ kind: "!", text: raw });
    }
  }
  return lines;
}

export function diffStats(diff: string, context = 3): DiffStats {
  const lines = parseDiff(diff);
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.kind === "+") additions++;
    else if (line.kind === "-") deletions++;
  }
  return { additions, deletions, hunks: toHunks(diff, context).length };
}

/**
 * 折叠为 hunk：只保留改动行前后各 context 行，相邻/重叠的窗口合并。
 * 大文件小改动不再整篇铺开——与 git diff 的信息密度一致。
 */
export function toHunks(diff: string, context = 3): DiffHunk[] {
  const lines = parseDiff(diff);
  if (lines.length === 0) {
    return [];
  }
  const ctx = Math.max(0, Math.floor(context));
  const changed: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const kind = lines[i]!.kind;
    if (kind === "+" || kind === "-") changed.push(i);
  }
  if (changed.length === 0) {
    return [];
  }
  const groups: { start: number; end: number }[] = [];
  for (const index of changed) {
    const start = Math.max(0, index - ctx);
    const end = Math.min(lines.length - 1, index + ctx);
    const last = groups[groups.length - 1];
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      groups.push({ start, end });
    }
  }
  // 前缀计数：旧/新行号域的累计行数，用来推 hunk 起点（纯新增时旧起点为 0 行）
  const prefixOld: number[] = new Array<number>(lines.length + 1).fill(0);
  const prefixNew: number[] = new Array<number>(lines.length + 1).fill(0);
  for (let i = 0; i < lines.length; i++) {
    prefixOld[i + 1] = prefixOld[i]! + (lines[i]!.oldNo !== undefined ? 1 : 0);
    prefixNew[i + 1] = prefixNew[i]! + (lines[i]!.newNo !== undefined ? 1 : 0);
  }
  return groups.map(({ start, end }) => {
    const oldCount = prefixOld[end + 1]! - prefixOld[start]!;
    const newCount = prefixNew[end + 1]! - prefixNew[start]!;
    const oldStart = oldCount === 0 ? prefixOld[start]! : prefixOld[start]! + 1;
    const newStart = newCount === 0 ? prefixNew[start]! : prefixNew[start]! + 1;
    return {
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      lines: lines.slice(start, end + 1),
    };
  });
}

/** 绝对路径 → 展示用相对路径（工作区内），统一正斜杠；跨盘/工作区外保留绝对路径 */
export function relativePath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  return (inside ? rel : path).split(sep).join("/");
}

/** 路径匹配归一化：Windows 反斜杠、大小写不影响 `/diff <文件>` 的筛选 */
export function normalizeForMatch(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

/** `/diff <文件>` 筛选：相对路径子串命中；查询本身是绝对路径时匹配绝对路径（空查询 = 全部） */
export function filterChanges<T extends { path: string }>(
  changes: readonly T[],
  query: string,
  cwd: string,
): T[] {
  const raw = query.trim();
  if (raw === "") {
    return [...changes];
  }
  const needle = normalizeForMatch(raw);
  // 绝对路径查询（含盘符/UNC）用绝对路径匹配，避免工作区目录名把子串查询放大成全命中
  const absoluteQuery = isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("//");
  return changes.filter((change) =>
    absoluteQuery
      ? normalizeForMatch(change.path).includes(needle)
      : normalizeForMatch(relativePath(change.path, cwd)).includes(needle),
  );
}

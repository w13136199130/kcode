import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * @ 文件引用补全（B4）：对 cwd 做一次有界递归列举（缓存），按前缀/子串过滤候选路径。
 * 排除 node_modules/.git 等噪声目录；深度与总量封顶，避免大仓库卡输入。
 */
const EXCLUDE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".idea", ".vscode"]);
const MAX_ENTRIES = 4000;
const MAX_DEPTH = 5;

const cache = new Map<string, { at: number; files: string[] }>();
const CACHE_TTL_MS = 30_000;

async function walk(dir: string, depth: number, out: string[], root: string): Promise<void> {
  if (out.length >= MAX_ENTRIES || depth > MAX_DEPTH) {
    return;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_ENTRIES) {
      return;
    }
    if (entry.name.startsWith(".") && entry.name !== ".github" && entry.isDirectory()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) {
        continue;
      }
      out.push(`${relative(root, join(dir, entry.name)).split(sep).join("/")}/`);
      await walk(join(dir, entry.name), depth + 1, out, root);
    } else {
      out.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
    }
  }
}

/** 获取 cwd 的候选路径清单（缓存 30s） */
export async function listProjectFiles(cwd: string): Promise<string[]> {
  const hit = cache.get(cwd);
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.files;
  }
  const files: string[] = [];
  await walk(cwd, 0, files, cwd);
  files.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  cache.set(cwd, { at: Date.now(), files });
  return files;
}

/** 过滤补全候选：前缀命中优先，其次子串；目录条目（尾 /）在空查询时优先展示 */
export function filterFileCandidates(files: string[], query: string, limit = 8): string[] {
  const q = query.toLowerCase();
  if (q === "") {
    return files.filter((f) => !f.includes("/")).slice(0, limit);
  }
  const starts: string[] = [];
  const contains: string[] = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    if (lower.startsWith(q)) {
      starts.push(f);
    } else if (lower.includes(q)) {
      contains.push(f);
    }
    if (starts.length >= limit) {
      break;
    }
  }
  return [...starts, ...contains].slice(0, limit);
}

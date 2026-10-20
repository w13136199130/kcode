import { readdir } from "node:fs/promises";
import { join } from "node:path";

const IGNORED = new Set(["node_modules", ".git", "dist", "build", ".next", "target"]);
const MAX_FILES = 5_000;

const cache = new Map<string, string[]>();

/** @ 文件补全索引：按 cwd 缓存；跳过重目录，最多 5000 条 */
async function indexWorkspace(cwd: string): Promise<string[]> {
  const cached = cache.get(cwd);
  if (cached !== undefined) return cached;
  const files: string[] = [];
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (files.length >= MAX_FILES || depth > 8) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (entry.name.startsWith(".") && entry.name !== ".kcode") continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (IGNORED.has(entry.name)) continue;
        await walk(join(dir, entry.name), rel, depth + 1);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  };
  await walk(cwd, "", 0);
  files.sort();
  cache.set(cwd, files);
  return files;
}

/** D1-05：Composer 的 @ 文件补全（query 为空返回少量文件，避免首屏刷屏） */
export async function searchWorkspaceFiles(cwd: string, query: string, limit = 40): Promise<string[]> {
  const files = await indexWorkspace(cwd);
  const q = query.toLowerCase();
  if (q === "") return files.slice(0, limit);
  const matched = files.filter((f) => f.toLowerCase().includes(q));
  matched.sort((a, b) => {
    const aStarts = a.toLowerCase().startsWith(q) ? 0 : 1;
    const bStarts = b.toLowerCase().startsWith(q) ? 0 : 1;
    return aStarts - bStarts || a.length - b.length || a.localeCompare(b);
  });
  return matched.slice(0, limit);
}

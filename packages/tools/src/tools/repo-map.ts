import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import type { Tool, ToolContext, ToolOutput } from "@kcode/contracts";

const MAX_FILES = 2_000;
const MAX_FILE_LINES = 500;
const DEFAULT_CHARS = 6_000;
const TTL_MS = 30_000;

const SOURCE_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,cs,rb,php,swift}";
const IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**", "**/coverage/**"];

const cache = new Map<string, { at: number; text: string }>();

function symbolsFor(file: string, source: string): string[] {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const symbols: string[] = [];
  const add = (name: string | undefined): void => {
    if (name !== undefined && !symbols.includes(name)) symbols.push(name);
  };
  const lines = source.split(/\r?\n/).slice(0, MAX_FILE_LINES);
  for (const line of lines) {
    if (ext === "py") {
      add(/^(?:class|def|async def)\s+([A-Za-z_]\w*)/.exec(line)?.[1]);
      continue;
    }
    if (ext === "go") {
      add(/^(?:func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(line)?.[1]);
      continue;
    }
    if (ext === "rs") {
      add(/^(?:pub\s+)?(?:fn|struct|enum|trait|mod|impl)\s+([A-Za-z_]\w*)/.exec(line)?.[1]);
      continue;
    }
    if (ext === "java" || ext === "kt" || ext === "cs") {
      add(/^(?:public|private|protected|internal|abstract|final|sealed)?\s*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/.exec(line)?.[1]);
      continue;
    }
    if (ext === "rb") {
      add(/^(?:class|module|def)\s+([A-Za-z_]\w*)/.exec(line)?.[1]);
      continue;
    }
    // TS/JS: exported/top-level declarations, plus common member declarations.
    add(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line)?.[1]);
    add(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line)?.[1]);
    add(/^\s*(?:public|private|protected|static|readonly|async|get|set)*\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/.exec(line)?.[1]);
  }
  return symbols.slice(0, 12);
}

function render(entries: { file: string; symbols: string[] }[], maxChars: number): string {
  const byDir = new Map<string, { file: string; symbols: string[] }[]>();
  for (const entry of entries) {
    const dir = dirname(entry.file).replace(/\\/g, "/");
    const key = dir === "." ? "" : dir;
    const list = byDir.get(key) ?? [];
    list.push(entry);
    byDir.set(key, list);
  }
  const lines: string[] = [];
  let used = 0;
  const push = (line: string): boolean => {
    if (used + line.length + 1 > maxChars) return false;
    lines.push(line);
    used += line.length + 1;
    return true;
  };
  for (const dir of [...byDir.keys()].sort()) {
    if (!push(dir === "" ? "./" : `${dir}/`)) break;
    for (const entry of byDir.get(dir)!.sort((a, b) => a.file.localeCompare(b.file))) {
      const name = entry.file.slice(entry.file.lastIndexOf("/") + 1);
      const text = `  ${name}: ${entry.symbols.join(", ")}`;
      if (!push(text)) return `${lines.join("\n")}\n…（repo map 按预算截断）`;
    }
  }
  return lines.join("\n");
}

export interface RepoMapOptions {
  /** 输出字符预算（约 4 chars/token） */
  maxChars?: number;
  /** 跳过模块级缓存（工具 refresh 用） */
  refresh?: boolean;
}

/** 生成仓库结构摘要；只读、只扫源码扩展名，默认忽略 node_modules/.git/dist。 */export async function buildRepoMap(cwd: string, opts: RepoMapOptions = {}): Promise<string> {
  const maxChars = Math.max(500, Math.min(64_000, opts.maxChars ?? DEFAULT_CHARS));
  const key = `${cwd}:${maxChars}`;
  const cached = cache.get(key);
  if (opts.refresh !== true && cached !== undefined && Date.now() - cached.at < TTL_MS) {
    return cached.text;
  }
  const files = (await fg(SOURCE_GLOB, {
    cwd,
    onlyFiles: true,
    dot: false,
    ignore: IGNORE,
    followSymbolicLinks: false,
    suppressErrors: true,
  }))
    .sort()
    .slice(0, MAX_FILES);
  const entries: { file: string; symbols: string[] }[] = [];
  for (const file of files) {
    try {
      const source = await readFile(join(cwd, file), "utf8");
      const symbols = symbolsFor(file, source);
      if (symbols.length > 0) entries.push({ file, symbols });
    } catch {
      // 单文件读取失败不影响整体 map
    }
  }
  const text = render(entries, maxChars);
  cache.set(key, { at: Date.now(), text });
  return text;
}

const RepoMapArgs = z.object({
  path: z.string().optional(),
  maxChars: z.number().int().min(500).max(64_000).optional(),
  refresh: z.boolean().optional(),
});

export const repoMapTool: Tool = {
  definition: {
    name: "repo_map",
    description: "生成仓库结构摘要（目录 + 文件 + 主要符号），按字符预算截断；只读、本地扫描，不联网",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "仓库根目录（默认会话 cwd）" },
        maxChars: { type: "integer", description: "输出字符预算，默认 6000（500-64000）" },
        refresh: { type: "boolean", description: "跳过 30s 缓存重新扫描" },
      },
    },
    readOnly: true,
    permission: { default: "allow" },
    timeoutMs: 30_000,
    resultBudget: 4096,
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const parsed = RepoMapArgs.safeParse(input);
    if (!parsed.success) return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
    const cwd =
      parsed.data.path === undefined
        ? (ctx.cwd ?? process.cwd())
        : resolve(ctx.cwd ?? process.cwd(), parsed.data.path);
    const text = await buildRepoMap(cwd, {
      ...(parsed.data.maxChars !== undefined ? { maxChars: parsed.data.maxChars } : {}),
      ...(parsed.data.refresh !== undefined ? { refresh: parsed.data.refresh } : {}),
    });
    return text.trim() === ""
      ? { ok: true, output: "（未发现可摘要的源码文件）" }
      : { ok: true, output: text };
  },
};

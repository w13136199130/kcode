import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import type { Tool } from "@kcode/contracts";
import { isSensitivePath } from "@kcode/shared";

const DEFAULT_LIMIT = 500;

const GlobArgs = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
  limit: z.number().int().positive().max(5000).optional(),
});

/** glob 工具：按模式列文件（fast-glob），默认忽略 node_modules/.git */
export const globTool: Tool = {
  definition: {
    name: "glob",
    description: '按 glob 模式列出文件路径（支持 "**/*.ts"），默认忽略 node_modules/.git，并尽量遵循 .gitignore',
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "glob 模式" },
        path: { type: "string", description: "搜索根目录，默认会话 cwd" },
        limit: { type: "integer", description: "返回条数上限，默认 500" },
      },
      required: ["pattern"],
    },
    readOnly: true,
    permission: { default: "allow" },
    timeoutMs: 30_000,
  },
  async execute(input, ctx) {
    const parsed = GlobArgs.safeParse(input);
    if (!parsed.success) {
      return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
    }
    const { pattern, path, limit } = parsed.data;
    const base = ctx.cwd ?? process.cwd();
    const root = path === undefined ? base : isAbsolute(path) ? path : resolve(base, path);

    let files: string[];
    try {
      files = await fg(pattern, {
        cwd: root,
        onlyFiles: true,
        dot: false,
        followSymbolicLinks: false,
        unique: true,
        ignore: ["**/node_modules/**", "**/.git/**", ...(await readGitignore(root))],
      });
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
    // 2-14：broad glob 不把敏感路径列给模型；显式指定敏感 pattern/path 时
    // 权限层已负责 ask/deny，保留结果以免“批准后仍看不到”。
    const explicitSensitive = isSensitivePath(pattern) || (path !== undefined && isSensitivePath(path));
    if (!explicitSensitive) {
      files = files.filter((file) => !isSensitivePath(file));
    }
    files.sort();
    const max = limit ?? DEFAULT_LIMIT;
    const shown = files.slice(0, max);
    if (shown.length === 0) {
      return { ok: true, output: "（无匹配）" };
    }
    const truncated =
      files.length > shown.length ? `\n（截断：共 ${files.length} 个匹配，仅显示前 ${max} 个）` : "";
    return { ok: true, output: `共 ${files.length} 个匹配\n${shown.join("\n")}${truncated}` };
  },
};

/**
 * 3-11：读取根目录 .gitignore 转成 fast-glob ignore。
 * 只做常用子集（目录、通配、根锚点）；`!` 反选与复杂 `**` 组合不展开。
 */
async function readGitignore(root: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(root, ".gitignore"), "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    let p = line.replace(/^\//, "");
    if (p.endsWith("/")) p = p.slice(0, -1);
    if (p === "") continue;
    if (!p.includes("/") && !p.includes("*")) {
      // 裸目录/文件名：按任意层级匹配
      out.push(`**/${p}/**`, `**/${p}`);
    } else if (p.endsWith("/**")) {
      out.push(p);
    } else {
      out.push(p, `**/${p}`);
    }
  }
  return out;
}

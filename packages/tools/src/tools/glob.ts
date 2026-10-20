import { isAbsolute, resolve } from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import type { Tool } from "@kcode/contracts";
import { isSensitivePath } from "@kcode/shared";

const DEFAULT_LIMIT = 500;

const GlobArgs = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
  limit: z.number().int().positive().optional(),
});

/** glob 工具：按模式列文件（fast-glob），默认忽略 node_modules/.git */
export const globTool: Tool = {
  definition: {
    name: "glob",
    description: '按 glob 模式列出文件路径（如 "**/*.ts"），默认忽略 node_modules/.git',
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
        ignore: ["**/node_modules/**", "**/.git/**"],
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

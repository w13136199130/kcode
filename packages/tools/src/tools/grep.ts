import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { z } from "zod";
import type { Tool } from "@kcode/contracts";

const DEFAULT_MAX_RESULTS = 200;
const MAX_OUTPUT_CHARS = 64_000;
const RG_TIMEOUT_MS = 10_000;

const GrepArgs = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
  glob: z.string().min(1).optional(),
  ignoreCase: z.boolean().optional(),
  maxResults: z.number().int().positive().optional(),
});

/** grep 工具：内容正则搜索，捆绑 ripgrep（§3 搜索性能底线），输出 file:line:text */
export const grepTool: Tool = {
  definition: {
    name: "grep",
    description: "在文件内容中搜索正则（捆绑 ripgrep），返回 file:line:text 匹配行",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "正则表达式" },
        path: { type: "string", description: "搜索根目录或单个文件，默认会话 cwd" },
        glob: { type: "string", description: '限定文件模式，如 "*.ts"' },
        ignoreCase: { type: "boolean", description: "忽略大小写" },
        maxResults: { type: "integer", description: "最大匹配数，默认 200" },
      },
      required: ["pattern"],
    },
    readOnly: true,
  },
  async execute(input, ctx) {
    const parsed = GrepArgs.safeParse(input);
    if (!parsed.success) {
      return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
    }
    const { pattern, path, glob, ignoreCase, maxResults } = parsed.data;
    const base = ctx.cwd ?? process.cwd();
    const root = path === undefined ? base : isAbsolute(path) ? path : resolve(base, path);

    const args = [
      "--line-number",
      "--no-heading",
      "--color",
      "never",
      "--max-count",
      String(maxResults ?? DEFAULT_MAX_RESULTS),
    ];
    if (ignoreCase === true) {
      args.push("-i");
    }
    if (glob !== undefined) {
      args.push("-g", glob);
    }
    args.push("-e", pattern, root);

    try {
      const { code, stdout, stderr } = await runRg(args);
      if (code === 2) {
        const msg = stderr.trim() !== "" ? stderr.trim() : `rg 退出码 ${code}`;
        return { ok: false, output: "", error: msg };
      }
      // rg 退出码：0=有匹配，1=无匹配（均非错误）
      if (stdout.trim() === "") {
        return { ok: true, output: "（无匹配）" };
      }
      let out = stdout.trimEnd();
      if (out.length > MAX_OUTPUT_CHARS) {
        out = `${out.slice(0, MAX_OUTPUT_CHARS)}\n（截断：输出超过 ${MAX_OUTPUT_CHARS} 字符）`;
      }
      return { ok: true, output: out };
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

function runRg(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(rgPath, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`rg 超时（${RG_TIMEOUT_MS / 1000}s）`));
    }, RG_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

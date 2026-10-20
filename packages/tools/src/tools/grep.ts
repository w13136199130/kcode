import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { z } from "zod";
import type { Tool } from "@kcode/contracts";
import { isSensitivePath } from "@kcode/shared";

const DEFAULT_MAX_RESULTS = 200;
/** 工具侧内存/回显护栏；发给模型的 token 预算由 definition.resultBudget 在 loop 层裁 */
const MAX_OUTPUT_CHARS = 64_000;
const RG_TIMEOUT_MS = 10_000;

const GrepArgs = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
  glob: z.string().min(1).optional(),
  ignoreCase: z.boolean().optional(),
  /** 3-11：上下文行数（rg -C，0-20） */
  context: z.number().int().min(0).max(20).optional(),
  /** 3-11：rg --type（如 ts/js/py） */
  fileType: z.string().min(1).optional(),
  /** 3-11：总匹配上限（rg 的 --max-count 是每文件，工具层再按总匹配截断） */
  maxResults: z.number().int().positive().max(1000).optional(),
});

/** grep 工具：内容正则搜索，捆绑 ripgrep（§3 搜索性能底线），输出 file:line:text */
export const grepTool: Tool = {
  definition: {
    name: "grep",
    description: "在文件内容中搜索正则（捆绑 ripgrep），返回 file:line:text；支持上下文、文件类型、总匹配上限",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "正则表达式" },
        path: { type: "string", description: "搜索根目录或单个文件，默认会话 cwd" },
        glob: { type: "string", description: '限定文件模式，如 "*.ts"' },
        ignoreCase: { type: "boolean", description: "忽略大小写" },
        context: { type: "integer", description: "上下文行数 0-20（rg -C）" },
        fileType: { type: "string", description: "文件类型，如 ts/js/py（rg --type）" },
        maxResults: { type: "integer", description: "总匹配上限，默认 200（最大 1000）" },
      },
      required: ["pattern"],
    },
    readOnly: true,
    permission: { default: "allow" },
    timeoutMs: 30_000,
    resultBudget: 4096,
  },
  async execute(input, ctx) {
    const parsed = GrepArgs.safeParse(input);
    if (!parsed.success) {
      return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
    }
    const { pattern, path, glob, ignoreCase, context, fileType, maxResults } = parsed.data;
    const base = ctx.cwd ?? process.cwd();
    const root = path === undefined ? base : isAbsolute(path) ? path : resolve(base, path);
    const totalLimit = maxResults ?? DEFAULT_MAX_RESULTS;

    const args = [
      "--line-number",
      "--no-heading",
      "--color",
      "never",
      // 3-11：跳过超大文件/二进制，避免一个日志文件撑爆结果；总匹配由工具层再截
      "--max-filesize",
      "2M",
      "--max-count",
      String(totalLimit),
    ];
    if (ignoreCase === true) {
      args.push("-i");
    }
    if (context !== undefined && context > 0) {
      args.push("-C", String(context));
    }
    if (fileType !== undefined) {
      args.push("--type", fileType);
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
      // 2-14：broad grep 不把 .env/.ssh 等命中行交给模型；显式指定敏感路径时
      // 权限层已负责 ask/deny，这里保留结果以免“批准后仍看不到内容”。
      const explicitSensitive =
        (path !== undefined && isSensitivePath(path)) || (glob !== undefined && isSensitivePath(glob));
      let out = explicitSensitive
        ? stdout.trimEnd()
        : stdout
            .trimEnd()
            .split("\n")
            .filter((line) => {
              const match = /^(.*?):\d+:/.exec(line);
              return !isSensitivePath(match?.[1] ?? line);
            })
            .join("\n");
      if (out === "") {
        return { ok: true, output: "（无匹配）" };
      }
      // 3-11：rg --max-count 是单文件上限，这里按总匹配行再截一次
      out = truncateTotalMatches(out, totalLimit);
      if (out.length > MAX_OUTPUT_CHARS) {
        out = `${out.slice(0, MAX_OUTPUT_CHARS)}\n（截断：输出超过 ${MAX_OUTPUT_CHARS} 字符）`;
      }
      return { ok: true, output: out };
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

/** rg 匹配行是 `path:line:text`；上下文行是 `path-line-text`，只数前者 */
function truncateTotalMatches(output: string, max: number): string {
  const lines = output.split("\n");
  let matches = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^.*?:\d+:/.test(lines[i] ?? "")) continue;
    matches += 1;
    if (matches > max) {
      return `${lines.slice(0, i).join("\n")}\n（截断：仅显示前 ${max} 个匹配；请缩小 path/glob/pattern 范围）`;
    }
  }
  return output;
}

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

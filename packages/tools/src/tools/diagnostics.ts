import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolOutput } from "@kcode/contracts";

const MAX_OUTPUT_CHARS = 12_000;

const DiagnosticsArgs = z.object({
  /** 目标文件/目录；缺省为会话 cwd */
  path: z.string().optional(),
  /** auto = 检测项目里的 tsc/eslint/pyright；也可强制单个 */
  kind: z.enum(["auto", "tsc", "eslint", "pyright"]).optional(),
  maxChars: z.number().int().min(500).max(64_000).optional(),
});

export interface Diagnostic {
  tool: "tsc" | "eslint" | "pyright";
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info";
  message: string;
  code?: string;
}

interface DiagnosticCommand {
  tool: "tsc" | "eslint" | "pyright";
  file: string;
  args: string[];
  cwd: string;
}

function findUp(start: string, names: readonly string[]): string | undefined {
  let current = resolve(start);
  for (;;) {
    for (const name of names) {
      const candidate = join(current, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** 纯检测：只在项目内寻找本地二进制，绝不走 npx/网络。 */
export function detectDiagnostics(cwd: string, target?: string): DiagnosticCommand[] {
  const start = target === undefined ? cwd : isAbsolute(target) ? target : resolve(cwd, target);
  const base = existsSync(start) ? start : target === undefined ? cwd : dirname(start);
  const marker = findUp(base, [
    "tsconfig.json",
    "eslint.config.js",
    "eslint.config.mjs",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    "pyrightconfig.json",
    "pyproject.toml",
  ]);
  const root = marker === undefined ? cwd : dirname(marker);
  const commands: DiagnosticCommand[] = [];

  const tsconfig = join(root, "tsconfig.json");
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  if (existsSync(tsconfig) && existsSync(tsc)) {
    commands.push({
      tool: "tsc",
      file: process.execPath,
      args: [tsc, "--noEmit", "--pretty", "false"],
      cwd: root,
    });
  }

  const eslintConfig = [
    "eslint.config.js",
    "eslint.config.mjs",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
  ].some((name) => existsSync(join(root, name)));
  const eslint = join(root, "node_modules", "eslint", "bin", "eslint.js");
  if (eslintConfig && existsSync(eslint)) {
    commands.push({
      tool: "eslint",
      file: process.execPath,
      args: [eslint, "--format", "unix", "."],
      cwd: root,
    });
  }

  const pyright = join(root, "node_modules", "pyright", "index.js");
  const pyrightConfig = existsSync(join(root, "pyrightconfig.json")) || existsSync(join(root, "pyproject.toml"));
  if (pyrightConfig && existsSync(pyright)) {
    commands.push({
      tool: "pyright",
      file: process.execPath,
      args: [pyright, "--outputjson"],
      cwd: root,
    });
  }
  return commands;
}

function parseTsc(text: string, root: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+(TS\d+)?:?\s+(.*)$/i.exec(line.trim());
    if (match === null) continue;
    out.push({
      tool: "tsc",
      file: resolve(root, match[1]!),
      line: Number(match[2]),
      column: Number(match[3]),
      severity: match[4]!.toLowerCase() as Diagnostic["severity"],
      message: match[6]!.trim(),
      ...(match[5] !== undefined ? { code: match[5] } : {}),
    });
  }
  return out;
}

function parseEslint(text: string, root: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(.+?):(\d+):(\d+):\s+(.*?)(?:\s+\[(Error|Warning)(?:\/([^\]]+))?\])?$/.exec(line.trim());
    if (match === null || match[1] === undefined) continue;
    out.push({
      tool: "eslint",
      file: resolve(root, match[1]),
      line: Number(match[2]),
      column: Number(match[3]),
      severity: match[5]?.toLowerCase() === "warning" ? "warning" : "error",
      message: match[4]!.trim(),
      ...(match[6] !== undefined ? { code: match[6] } : {}),
    });
  }
  return out;
}

interface PyrightJson {
  generalDiagnostics?: {
    file: string;
    severity: string;
    message: string;
    range?: { start?: { line?: number; character?: number } };
  }[];
}

function parsePyright(text: string): Diagnostic[] {
  const jsonStart = text.indexOf("{");
  if (jsonStart === -1) return [];
  try {
    const parsed = JSON.parse(text.slice(jsonStart)) as PyrightJson;
    return (parsed.generalDiagnostics ?? []).map((entry) => ({
      tool: "pyright" as const,
      file: entry.file,
      line: (entry.range?.start?.line ?? 0) + 1,
      column: (entry.range?.start?.character ?? 0) + 1,
      severity: entry.severity === "warning" ? "warning" : entry.severity === "information" ? "info" : "error",
      message: entry.message,
    }));
  } catch {
    return [];
  }
}

export function parseDiagnostics(tool: DiagnosticCommand["tool"], text: string, root: string): Diagnostic[] {
  if (tool === "tsc") return parseTsc(text, root);
  if (tool === "eslint") return parseEslint(text, root);
  return parsePyright(text);
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => resolve(p).replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
}

function filterDiagnostics(
  diagnostics: Diagnostic[],
  filterPaths: readonly string[] | undefined,
): { shown: Diagnostic[]; hidden: number } {
  if (filterPaths === undefined || filterPaths.length === 0) {
    return { shown: diagnostics, hidden: 0 };
  }
  const shown = diagnostics.filter((d) => filterPaths.some((path) => samePath(d.file, path)));
  return { shown, hidden: diagnostics.length - shown.length };
}

function formatDiagnostic(d: Diagnostic, root: string): string {
  const file = isAbsolute(d.file) ? d.file : resolve(root, d.file);
  const code = d.code !== undefined ? `${d.code}: ` : "";
  return `${file}:${d.line}:${d.column} ${d.severity}: ${code}${d.message}`;
}

function run(command: DiagnosticCommand, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number; text: string; error?: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command.file, command.args, {
      cwd: command.cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { code: number; text: string; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: -1, text: "", error: `${command.tool} 超时（${timeoutMs}ms）` });
    }, timeoutMs);
    const onAbort = (): void => {
      child.kill();
      finish({ code: -1, text: "", error: `${command.tool} 已中断` });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      finish({ code: -1, text: "", error: `${command.tool} 启动失败：${err.message}` });
    });
    child.on("close", (code) => {
      finish({ code: code ?? -1, text: `${stdout}${stderr}`.trim() });
    });
  });
}

export interface RunDiagnosticsResult {
  ran: boolean;
  output: string;
  total: number;
}

export async function runDiagnostics(opts: {
  cwd: string;
  target?: string;
  kind?: "auto" | "tsc" | "eslint" | "pyright";
  maxChars?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 只显示这些改动文件的诊断；缺省显示全部 */
  filterPaths?: readonly string[];
}): Promise<RunDiagnosticsResult> {
  const detected = detectDiagnostics(opts.cwd, opts.target);
  const commands =
    opts.kind === undefined || opts.kind === "auto"
      ? detected
      : detected.filter((command) => command.tool === opts.kind);
  if (commands.length === 0) {
    return {
      ran: false,
      output: "未检测到可用的诊断命令（需要本地 tsconfig/eslint/pyright 配置与 node_modules 二进制）",
      total: 0,
    };
  }
  const outputs: string[] = [];
  let remaining = opts.maxChars ?? MAX_OUTPUT_CHARS;
  let total = 0;
  for (const command of commands) {
    const result = await run(command, opts.timeoutMs ?? 60_000, opts.signal);
    const parsed = parseDiagnostics(command.tool, result.text, command.cwd);
    total += parsed.length;
    const filtered = filterDiagnostics(parsed, opts.filterPaths);
    const body = result.error
      ? result.error
      : filtered.shown.length > 0
        ? `${filtered.shown.map((d) => formatDiagnostic(d, command.cwd)).join("\n")}${
            filtered.hidden > 0 ? `\n（项目其它文件 ${filtered.hidden} 条已过滤）` : ""
          }`
        : parsed.length === 0
          ? "无诊断"
          : `本次改动文件无诊断（项目其它文件 ${filtered.hidden} 条已过滤）`;
    const header = `── [${command.tool} exit=${result.code}] @ ${command.cwd} ──\n`;
    const slice = (header + body).slice(0, Math.max(0, remaining));
    outputs.push(slice);
    remaining -= slice.length;
    if (remaining <= 0) break;
  }
  return { ran: true, output: outputs.join("\n\n"), total };
}

/** 显式诊断工具：模型改完文件后可主动调用，不依赖自动包装。 */
export const diagnosticsTool: Tool = {
  definition: {
    name: "diagnostics",
    description: "运行项目本地类型/静态检查（tsc/eslint/pyright），返回文件:行:列的诊断；不安装依赖、不走网络",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标文件或目录（默认会话 cwd）" },
        kind: { type: "string", enum: ["auto", "tsc", "eslint", "pyright"], description: "诊断类型，默认 auto" },
        maxChars: { type: "integer", description: "输出上限字符（500-64000）" },
      },
    },
    readOnly: true,
    permission: { default: "allow" },
    timeoutMs: 120_000,
    resultBudget: 8192,
  },
  async execute(input, ctx: ToolContext): Promise<ToolOutput> {
    const parsed = DiagnosticsArgs.safeParse(input);
    if (!parsed.success) {
      return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
    }
    const cwd = ctx.cwd ?? process.cwd();
    const target = parsed.data.path === undefined ? undefined : resolve(cwd, parsed.data.path);
    const filterPaths =
      target !== undefined && existsSync(target) && statSync(target).isFile() ? [target] : undefined;
    const result = await runDiagnostics({
      cwd,
      ...(target !== undefined ? { target } : {}),
      ...(parsed.data.kind !== undefined ? { kind: parsed.data.kind } : {}),
      ...(parsed.data.maxChars !== undefined ? { maxChars: parsed.data.maxChars } : {}),
      ...(filterPaths !== undefined ? { filterPaths } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    if (!result.ran) return { ok: false, output: "", error: result.output };
    return { ok: true, output: result.output };
  },
};

/** 4-03 自动回灌：只包装文件 mutation 工具；诊断失败不改变原工具结果。 */
export function withDiagnostics(tool: Tool): Tool {
  return {
    ...tool,
    async execute(input, ctx) {
      const result = await tool.execute(input, ctx);
      if (!result.ok) return result;
      const target =
        typeof input === "object" && input !== null
          ? typeof (input as { path?: unknown }).path === "string"
            ? String((input as { path: string }).path)
            : typeof (input as { file_path?: unknown }).file_path === "string"
              ? String((input as { file_path: string }).file_path)
              : undefined
          : undefined;
      const filterPath =
        target === undefined
          ? undefined
          : isAbsolute(target)
            ? target
            : resolve(ctx.cwd ?? process.cwd(), target);
      const diagnostics = await runDiagnostics({
        cwd: ctx.cwd ?? process.cwd(),
        ...(target !== undefined ? { target } : {}),
        ...(filterPath !== undefined ? { filterPaths: [filterPath] } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      }).catch((err: unknown) => ({
        ran: false,
        output: err instanceof Error ? err.message : String(err),
        total: 0,
      }));
      if (!diagnostics.ran || diagnostics.output.trim() === "") return result;
      return {
        ...result,
        output: `${result.output}\n\n<diagnostics>\n${diagnostics.output}\n</diagnostics>`,
      };
    },
  };
}

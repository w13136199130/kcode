import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { z } from "zod";
import type { Tool } from "@kcode/contracts";
import { newId } from "@kcode/shared";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 64_000;

const BashArgs = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
  runInBackground: z.boolean().optional(),
  cwd: z.string().min(1).optional(),
});

export interface BashToolOptions {
  sessionId: string;
  /** 后台任务日志目录（artifacts/sess_x，§4.3）；缺省时后台任务将被拒绝并提示 */
  artifactsDir?: string;
  /** 后台任务完成通知（§5.1：任务表 + 完成通知） */
  onNotice?: (message: string) => void;
}

export interface BackgroundTask {
  id: string;
  command: string;
  status: "running" | "done" | "failed";
  exitCode?: number;
  logPath: string;
  startedAt: number;
}

export class BackgroundTaskRegistry {
  readonly #tasks = new Map<string, BackgroundTask>();

  list(): BackgroundTask[] {
    return [...this.#tasks.values()];
  }

  get(id: string): BackgroundTask | undefined {
    return this.#tasks.get(id);
  }

  track(task: BackgroundTask): void {
    this.#tasks.set(task.id, task);
  }

  update(id: string, patch: Partial<BackgroundTask>): void {
    const task = this.#tasks.get(id);
    if (task !== undefined) {
      Object.assign(task, patch);
    }
  }
}

/**
 * bash 工具（§9 B 域）：跨平台 shell（Windows PowerShell / Unix bash）、超时、后台任务。
 * 会话级持久 shell 状态（cd/env 跨调用）留待 P1-6；当前每调用独立 shell。
 */
export function createBashTool(opts: BashToolOptions): Tool {
  const registry = new BackgroundTaskRegistry();
  // 预热 shell 探测（记忆化，后续 execute 即时可用）
  void shellOnce();
  return {
    definition: {
      name: "bash",
      description:
        "执行 shell 命令（bash 语法，输出 UTF-8；无 git-bash 时回退 PowerShell，系统提示环境块会注明）；默认 120s 超时；runInBackground 后台执行，日志落盘 artifacts",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "命令内容" },
          timeoutMs: { type: "integer", description: "前台超时毫秒数，默认 120000" },
          runInBackground: { type: "boolean", description: "后台执行，立即返回任务号与日志路径" },
          cwd: { type: "string", description: "工作目录，默认会话 cwd" },
        },
        required: ["command"],
      },
      readOnly: false,
    },
    async execute(input, ctx) {
      const parsed = BashArgs.safeParse(input);
      if (!parsed.success) {
        return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
      }
      const { command, timeoutMs, runInBackground, cwd } = parsed.data;
      const workDir = cwd ?? ctx.cwd;
      const shell = await shellOnce();
      const shellArgs = shell.args(command);

      if (runInBackground === true) {
        if (opts.artifactsDir === undefined) {
          return { ok: false, output: "", error: "后台任务未配置日志目录（artifactsDir），无法启动" };
        }
        await mkdir(opts.artifactsDir, { recursive: true });
        const id = newId("bg");
        const logPath = join(opts.artifactsDir, `${id}.log`);
        // "w" 而非 "a"：MSYS(git-bash) 对 append 模式句柄作为 stdio 会静默 exit 1
        const logFile = await open(logPath, "w");
        const child = spawn(shell.file, shellArgs, {
          cwd: workDir,
          stdio: ["ignore", logFile.fd, logFile.fd],
          windowsHide: true,
        });
        registry.track({ id, command, status: "running", logPath, startedAt: Date.now() });
        child.on("error", (err) => {
          registry.update(id, { status: "failed" });
          void logFile.close();
          opts.onNotice?.(`后台任务 ${id} 启动失败：${err.message}`);
        });
        child.on("close", (code) => {
          registry.update(id, { status: code === 0 ? "done" : "failed", exitCode: code ?? -1 });
          void logFile.close();
          opts.onNotice?.(
            `后台任务 ${id} ${code === 0 ? "完成" : `失败（exit ${code}）`}：${command.slice(0, 60)} · 日志 ${logPath}`,
          );
        });
        return { ok: true, output: `后台任务已启动 ${id}；日志：${logPath}` };
      }

      try {
        const { code, output } = await runShell(shell.file, shellArgs, workDir, timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const capped = capOutput(output);
        if (code === 0) {
          return { ok: true, output: capped };
        }
        return { ok: false, output: capped, error: `exit code ${code}` };
      } catch (err) {
        return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** PowerShell 侧强制 UTF-8 输出：中文 Windows 默认 GBK 代码页会输出乱码 */
const PS_UTF8_PREFIX = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;";

export interface ShellChoice {
  name: "bash" | "powershell";
  file: string;
  args: (command: string) => string[];
}

/**
 * 跨平台 shell 选择：Windows 优先 git-bash（模型写 bash 语法最流畅，且输出原生 UTF-8，
 * 规避「bash 语法打到 PowerShell 报错 → 换写法 → 中文乱码 → 再重试」的补偿循环），
 * 无可用 git-bash 时回退 PowerShell（前置 UTF-8 控制台编码，保留真实退出码）。
 * 探测跳过 \Windows\ 下的 bash.exe（那是 WSL 启动器：未装发行版时必失败且错误 GBK 乱码），
 * 并用一次性探针命令验证候选真的能执行。
 */
async function resolveShell(): Promise<ShellChoice> {
  if (process.platform !== "win32") {
    return { name: "bash", file: "bash", args: (c) => ["-c", c] };
  }
  const bash = await detectWindowsBash();
  if (bash !== undefined) {
    return { name: "bash", file: bash, args: (c) => ["-c", c] };
  }
  return {
    name: "powershell",
    file: "powershell.exe",
    args: (c) => [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `${PS_UTF8_PREFIX} ${c}; exit $LASTEXITCODE`,
    ],
  };
}

let cachedShell: Promise<ShellChoice> | undefined;

/** 解析结果进程内记忆化（首次含子进程探针，约百毫秒） */
function shellOnce(): Promise<ShellChoice> {
  cachedShell ??= resolveShell();
  return cachedShell;
}

/**
 * Windows 上筛选 bash 候选路径：跳过 \Windows\ 目录（WSL 启动器）。
 * exists 可注入供测试；生产缺省 existsSync。
 */
export function pickBashCandidates(
  dirs: string[],
  exists: (p: string) => boolean = existsSync,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    if (dir === "") continue;
    const lower = dir.toLowerCase();
    if (lower.startsWith("c:\\windows") || lower.includes("\\windows\\system32")) continue;
    const candidate = join(dir.trim(), "bash.exe");
    if (seen.has(candidate) || !exists(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

function commonBashDirs(): string[] {
  const programDirs = [
    process.env["ProgramFiles"],
    process.env["ProgramFiles(x86)"],
    process.env["LOCALAPPDATA"] !== undefined
      ? join(process.env["LOCALAPPDATA"], "Programs")
      : undefined,
  ].filter((d): d is string => d !== undefined);
  const out: string[] = [];
  for (const base of programDirs) {
    for (const sub of ["Git\\bin", "Git\\usr\\bin"]) {
      out.push(join(base, sub, "bash.exe"));
    }
  }
  return out;
}

/** 探针标记：候选 bash 必须能真正执行并回显 */
const BASH_PROBE_MARKER = "__kcode_bash_ok__";

async function probeBashWorks(bashPath: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const child = spawn(bashPath, ["-c", `echo ${BASH_PROBE_MARKER}`], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolveProbe(false);
    }, 4000);
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolveProbe(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveProbe(code === 0 && out.includes(BASH_PROBE_MARKER));
    });
  });
}

/** 探测 Windows 上可用的 git-bash：PATH 候选（过滤 WSL）→ 常见安装位 → 逐个探针验证 */
export async function detectWindowsBash(): Promise<string | undefined> {
  const candidates = [
    ...pickBashCandidates((process.env.PATH ?? "").split(delimiter)),
    ...commonBashDirs().filter((p) => existsSync(p)),
  ];
  for (const candidate of candidates) {
    if (await probeBashWorks(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** 运行环境 shell 信息（composition 注入系统提示，模型不再猜 shell 方言） */
export async function currentShellInfo(): Promise<{ name: "bash" | "powershell"; dialect: string }> {
  const shell = await shellOnce();
  return shell.name === "bash"
    ? { name: "bash", dialect: "bash（git-bash，输出 UTF-8）" }
    : { name: "powershell", dialect: "PowerShell（命令必须用 PowerShell 语法）" };
}

function runShell(
  file: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: true });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`命令超时（${Math.round(timeoutMs / 1000)}s），已终止`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, output });
    });
  });
}

function capOutput(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n（截断：输出超过 ${MAX_OUTPUT_CHARS} 字符）`
    : text;
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
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
 * 每次调用仍是独立短命 shell 进程，但前台命令结束后打点回传 $PWD 作为会话级持久
 * 工作目录，下次调用以该目录启动——cd 跨调用保留；环境变量/函数不保留。
 */
export function createBashTool(opts: BashToolOptions): Tool {
  const registry = new BackgroundTaskRegistry();
  // 会话级持久工作目录：上次前台命令结束时的 $PWD；显式 cwd 参数 > 持久目录 > 会话 cwd
  let lastCwd: string | undefined;
  // 预热 shell 探测（记忆化，后续 execute 即时可用）
  void shellOnce();
  return {
    definition: {
      name: "bash",
      description:
        "执行 shell 命令（bash 语法，输出 UTF-8；无 git-bash 时回退 PowerShell，系统提示环境块会注明）；默认 120s 超时；runInBackground 后台执行，日志落盘 artifacts；工作目录跨调用保留（cd 持久），路径优先写绝对路径",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "命令内容" },
          timeoutMs: { type: "integer", description: "前台超时毫秒数，默认 120000" },
          runInBackground: { type: "boolean", description: "后台执行，立即返回任务号与日志路径" },
          cwd: { type: "string", description: "本次调用的 工作目录；缺省延续上次 cd 的目录（会话内持久）" },
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
      // 持久目录优先级：显式 cwd > 上次打点回传的 lastCwd（目录可能已被删除，存在性守卫自愈）> 会话 cwd
      const persisted = lastCwd !== undefined && existsSync(lastCwd) ? lastCwd : undefined;
      const workDir = cwd ?? persisted ?? ctx.cwd;
      const shell = await shellOnce();

      if (runInBackground === true) {
        if (opts.artifactsDir === undefined) {
          return { ok: false, output: "", error: "后台任务未配置日志目录（artifactsDir），无法启动" };
        }
        await mkdir(opts.artifactsDir, { recursive: true });
        const id = newId("bg");
        const logPath = join(opts.artifactsDir, `${id}.log`);
        // "w" 而非 "a"：MSYS(git-bash) 对 append 模式句柄作为 stdio 会静默 exit 1
        const logFile = await open(logPath, "w");
        // 后台命令不打点（保持日志纯净），在当前持久目录启动，也不回写持久目录
        const child = spawn(shell.file, shell.args(command), {
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
        const nonce = randomNonce();
        const { code, output } = await runShell(
          shell.file,
          shell.args(markCommandForSnapshot(shell.name, command, nonce)),
          workDir,
          timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ctx.signal,
        );
        // 打点行剥除后再截断（打点在输出末尾，先剥可免被截断吞掉）；中断/超时/语法错误时无打点，保持旧目录
        const snapshot = extractShellSnapshot(output, nonce);
        if (snapshot.cwd !== undefined) {
          lastCwd = process.platform === "win32" ? msysPathToWin32(snapshot.cwd) : snapshot.cwd;
        }
        const capped = capOutput(snapshot.output);
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

interface ShellChoice {
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
    // 非 login shell 不加载 Git 的 profile；显式加入所选安装的工具目录，
    // 否则 PATH 只有 Git/cmd 时 sleep/cygpath 不可用，/tmp 也无法转换为原生路径。
    const msys = (path: string): string => path.replace(/\\/g, "/").replace(/^([a-z]):/i, (_, drive: string) => `/${drive.toLowerCase()}`);
    const bin = msys(dirname(bash));
    const usrBin = msys(join(dirname(bash), "..", "usr", "bin"));
    const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
    return { name: "bash", file: bash, args: (c) => ["-c", `export PATH=${quote(bin)}:${quote(usrBin)}:"$PATH"\n${c}`] };
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

/**
 * 由 PATH 上的 git.exe 反推同级 bash（git 常把 \cmd 加入 PATH 而 \usr\bin 不在）：
 * <gitdir>\cmd\git.exe → <gitdir>\usr\bin\bash.exe / <gitdir>\bin\bash.exe。
 */
function bashDirsFromGitExe(dirs: string[], exists: (p: string) => boolean = existsSync): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    if (dir === "") continue;
    const lower = dir.toLowerCase();
    if (lower.startsWith("c:\\windows") || lower.includes("\\windows\\system32")) continue;
    if (!exists(join(dir.trim(), "git.exe"))) continue;
    const gitRoot = dirname(dir.trim());
    for (const sub of ["usr\\bin", "bin"]) {
      const candidate = join(gitRoot, sub, "bash.exe");
      if (exists(candidate)) {
        out.push(candidate);
      }
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

/** 探测 Windows 上可用的 git-bash：PATH 候选（过滤 WSL）→ git.exe 反推 → 常见安装位 → 探针验证 */
export async function detectWindowsBash(): Promise<string | undefined> {
  const pathDirs = (process.env.PATH ?? "").split(delimiter);
  const candidates = [
    ...pickBashCandidates(pathDirs),
    ...bashDirsFromGitExe(pathDirs),
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

/** 结束子进程树：shell 会派生子进程，直接 kill 只杀壳不杀孙——Windows 用 taskkill /T /F */
function killTree(child: import("node:child_process").ChildProcess): void {
  if (child.pid === undefined) {
    child.kill();
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGKILL");
  }
}

function runShell(
  file: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: true });
    let output = "";
    // 用户中断（Esc/Ctrl+C）：立即杀树并结算（不等 120s 超时）
    const onAbort = (): void => {
      killTree(child);
      clearTimeout(timer);
      resolvePromise({ code: -1, output: `${output}
（已被用户中断）` });
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      killTree(child);
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
      signal?.removeEventListener("abort", onAbort);
      resolvePromise({ code: code ?? -1, output });
    });
  });
}

function capOutput(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n（截断：输出超过 ${MAX_OUTPUT_CHARS} 字符）`
    : text;
}

/** 工作目录打点前缀：随机 nonce 后缀防与用户输出巧合碰撞 */
const SHELL_SNAPSHOT_PREFIX = "__kcode_pwd_";

function randomNonce(): string {
  return Math.random().toString(36).slice(2, 12);
}

/**
 * 前台命令尾部追加打点：命令结束后回传当前目录，供下次调用恢复 cwd。
 * bash 侧用 cygpath -w 把 $PWD 转成 Win32 路径（git-bash 会把 Windows 目录映射成
 * /tmp 等 MSYS 视图，无盘符形式 JS 侧无法还原；cygpath 缺失时回退原始 $PWD），
 * 先记录退出码再打点、末尾 exit 还原（进程退出码语义不变）；
 * PowerShell 侧退出码沿用外层 `exit $LASTEXITCODE` 不变。
 * 命令语法错误 / 主动 exit / 被中断杀树时打点不会出现——extractShellSnapshot 判无即跳过。
 */
function markCommandForSnapshot(
  shellName: "bash" | "powershell",
  command: string,
  nonce: string,
): string {
  if (shellName === "powershell") {
    return `${command}; Write-Output "${SHELL_SNAPSHOT_PREFIX}${nonce}:$pwd"`;
  }
  const reportPwd = `"$(cygpath -w "$PWD" 2>/dev/null || printf '%s' "$PWD")"`;
  return `${command}; __kcode_rc=$?; printf '\\n${SHELL_SNAPSHOT_PREFIX}${nonce}:%s\\n' ${reportPwd}; exit $__kcode_rc`;
}

/** 从输出中提取打点行：返回回传目录与剥除打点行后的输出（取最后一次出现） */
export function extractShellSnapshot(
  output: string,
  nonce: string,
): { cwd?: string; output: string } {
  const token = `${SHELL_SNAPSHOT_PREFIX}${nonce}:`;
  const idx = output.lastIndexOf(token);
  if (idx === -1) {
    return { output };
  }
  const lineEnd = output.indexOf("\n", idx);
  const cwd = (
    lineEnd === -1 ? output.slice(idx + token.length) : output.slice(idx + token.length, lineEnd)
  ).replace(/\r$/, "");
  const lineStart = output.lastIndexOf("\n", idx - 1);
  const before = lineStart === -1 ? "" : output.slice(0, lineStart);
  const after = lineEnd === -1 ? "" : output.slice(lineEnd + 1);
  return { cwd: cwd.length > 0 ? cwd : undefined, output: before + after };
}

/** MSYS(git-bash) 的 $PWD 是 POSIX 风格（/e/foo）；转 Win32（E:\foo）供下次 spawn 的 cwd 使用（盘符大写与 Node 一致） */
export function msysPathToWin32(p: string): string {
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
  const drive = m?.[1];
  const rest = m?.[2];
  if (m === null || drive === undefined || rest === undefined) {
    return p;
  }
  return `${drive.toUpperCase()}:\\${rest.replace(/\//g, "\\")}`;
}

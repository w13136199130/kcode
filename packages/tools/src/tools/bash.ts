import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { Tool } from "@kcode/contracts";
import { newId } from "@kcode/shared";
import { detectWindowsBash } from "./shell-detect.js";
import { OutputCollector, type OutputLimits } from "./output-collector.js";

const DEFAULT_TIMEOUT_MS = 120_000;

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
  /**
   * 外部注入的后台任务注册表（N3C-4③）：注入后会话层持有同一实例，
   * 句柄/面板经它查询任务清单；缺省时工具自建（行为不变）。
   */
  registry?: BackgroundTaskRegistry;
  /** 前台输出三段预算覆盖（N3E-1，测试注入用；缺省 30k/2k/1M） */
  outputLimits?: Partial<OutputLimits>;
}

export interface BackgroundTask {
  id: string;
  command: string;
  status: "running" | "done" | "failed";
  exitCode?: number;
  logPath: string;
  startedAt: number;
  /**
   * 完成通知已送达（N3D-1 幂等，对标 zcode runner.ts:1847）：
   * 后台子代理的终态经 task_output 读取即认领，防止"工具结果+通知"双送达。
   */
  notified?: boolean;
}

export class BackgroundTaskRegistry {
  readonly #tasks = new Map<string, BackgroundTask>();
  /** 运行中任务的子进程引用（task_stop 终止用）；进程退出即清理 */
  readonly #children = new Map<string, ChildProcess>();

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

  /** 挂子进程引用（track 之后调用）；close 后自动摘除 */
  attach(id: string, child: ChildProcess): void {
    this.#children.set(id, child);
    child.on("close", () => this.#children.delete(id));
  }

  /**
   * 终止运行中的后台任务；返回是否真的发送了终止信号。
   * Windows 上 kill 只终止直接子进程（孙进程不追杀）——与前台超时同一边界。
   */
  stop(id: string): boolean {
    const child = this.#children.get(id);
    if (child === undefined || child.killed || child.exitCode !== null) {
      return false;
    }
    child.kill();
    return true;
  }
}

/**
 * bash 工具（§9 B 域；N3E-1/2 升级）：跨平台 shell、超时、后台任务。
 * 前台输出走三段预算（内联 30k / 超限全文落盘 artifacts / 尾部保留）；
 * 持久工作目录仅在项目边界内保留（越界重置回会话目录并提示）。
 */
export function createBashTool(opts: BashToolOptions): Tool {
  // 注册表优先用注入实例：会话层（句柄/面板）与工具共享同一份任务事实
  const registry = opts.registry ?? new BackgroundTaskRegistry();
  // 会话级持久工作目录：上次前台命令结束时的 $PWD；显式 cwd 参数 > 持久目录 > 会话 cwd
  let lastCwd: string | undefined;
  // 预热 shell 探测（记忆化，后续 execute 即时可用）
  void shellOnce();
  return {
    definition: {
      name: "bash",
      description:
        "执行 shell 命令（bash 语法，输出 UTF-8；无 git-bash 时回退 PowerShell，系统提示环境块会注明）；默认 120s 超时；长输出三段预算（内联约 30k 字符，超限全文落盘 artifacts 并保留尾部）；runInBackground 后台执行；工作目录跨调用保留（限项目内，越界自动重置）",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的命令（bash 语法）" },
          timeoutMs: { type: "number", description: "超时毫秒（默认 120000）" },
          runInBackground: { type: "boolean", description: "后台执行，立即返回任务号与日志路径" },
          cwd: { type: "string", description: "本次命令的工作目录（默认沿用上次目录/会话目录）" },
        },
        required: ["command"],
      },
      readOnly: false,
      permission: { default: "ask", acceptEdits: "ask" },
      timeoutMs: 600_000,
      resultBudget: 4096,
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
        registry.attach(id, child);
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
        // 三段预算（N3E-1）：落盘目标 = artifacts/<callId>.log；无 artifactsDir/无 callId 时降级纯截断
        const collector = new OutputCollector(
          opts.outputLimits,
          opts.artifactsDir !== undefined && ctx.callId !== undefined
            ? join(opts.artifactsDir, `${ctx.callId}.log`)
            : undefined,
        );
        const { code } = await runShell(
          shell.file,
          shell.args(markCommandForSnapshot(shell.name, command, nonce)),
          workDir,
          timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ctx.signal,
          collector,
        );
        // 打点行剥除后再终态编排（打点在输出末尾，先剥可免被编进尾部）；中断/超时/语法错误时无打点，保持旧目录
        const snapshot = extractShellSnapshot(collector.getText(), nonce);
        let boundaryNote = "";
        if (snapshot.cwd !== undefined) {
          const candidate = process.platform === "win32" ? msysPathToWin32(snapshot.cwd) : snapshot.cwd;
          // 无会话 cwd 锚点时无从判界，维持旧行为直接持久
          if (ctx.cwd === undefined || isWithinPath(ctx.cwd, candidate)) {
            lastCwd = candidate;
          } else {
            // N3E-2 项目边界（对标 zcode decideBashCwdPolicy）：越界不持久，重置回会话目录并告知模型
            lastCwd = undefined;
            boundaryNote = `\n⚠ 工作目录已离开项目（${candidate}）——持久目录重置回 ${ctx.cwd}；操作系统外路径请每次显式 cd 或用绝对路径`;
          }
        }
        const result = await collector.finish((text) => extractShellSnapshot(text, nonce).output);
        const text = boundaryNote === "" ? result.text : `${result.text}${boundaryNote}`;
        if (code === 0) {
          return { ok: true, output: text };
        }
        return { ok: false, output: text, error: `exit code ${code}` };
      } catch (err) {
        return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** target 是否位于 base 子树内（含相等）；Windows 按大小写不敏感比较 */
function isWithinPath(base: string, target: string): boolean {
  const norm = (p: string): string => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(norm(base), norm(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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

/** 运行环境 shell 信息（composition 注入系统提示，模型不再猜 shell 方言） */
export async function currentShellInfo(): Promise<{ name: "bash" | "powershell"; dialect: string }> {
  const shell = await shellOnce();
  return shell.name === "bash"
    ? { name: "bash", dialect: "bash（git-bash，输出 UTF-8）" }
    : { name: "powershell", dialect: "PowerShell（命令必须用 PowerShell 语法）" };
}

/** 结束子进程树：shell 会派生子进程，直接 kill 只杀壳不杀孙——Windows 用 taskkill /T /F */
function killTree(child: ChildProcess): void {
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

/** 前台执行：输出进三段预算收集器（内存有硬顶），退出码与收集器一并返回 */
function runShell(
  file: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  collector: OutputCollector,
): Promise<{ code: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: true });
    // 用户中断（Esc/Ctrl+C）：立即杀树并结算（不等 120s 超时）
    const onAbort = (): void => {
      killTree(child);
      clearTimeout(timer);
      collector.append("\n（已被用户中断）");
      resolvePromise({ code: -1 });
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
      collector.append(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      collector.append(chunk.toString("utf8"));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise({ code: code ?? -1 });
    });
  });
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

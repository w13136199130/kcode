import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
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
  return {
    definition: {
      name: "bash",
      description:
        "执行 shell 命令（Windows 用 PowerShell，其余 bash）；默认 120s 超时；runInBackground 后台执行，日志落盘 artifacts",
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
      const shell = shellCommand(command);

      if (runInBackground === true) {
        if (opts.artifactsDir === undefined) {
          return { ok: false, output: "", error: "后台任务未配置日志目录（artifactsDir），无法启动" };
        }
        await mkdir(opts.artifactsDir, { recursive: true });
        const id = newId("bg");
        const logPath = join(opts.artifactsDir, `${id}.log`);
        const logFile = await open(logPath, "a");
        const child = spawn(shell.file, shell.args, {
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
        const { code, output } = await runShell(shell.file, shell.args, workDir, timeoutMs ?? DEFAULT_TIMEOUT_MS);
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

/** §6：Windows 优先 PowerShell（-NoProfile -NonInteractive 防配置噪音），fallback 由宿主环境决定 */
function shellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
  }
  return { file: "bash", args: ["-c", command] };
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

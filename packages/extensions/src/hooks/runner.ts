import { spawn } from "node:child_process";
import {
  HookOutcome,
  type HookConfig,
  type HookEventName,
  type HookRunner,
  type ToolCallRef,
  type ToolOutput,
} from "@kcode/contracts";

/** 单个钩子的默认执行超时 */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ProcessHookRunnerOptions {
  sessionId: string;
  /** 告警通道（超时、非零退出等不阻断会话的情况）；缺省静默 */
  onWarn?: (message: string) => void;
}

interface HookExecution {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * 进程版钩子执行器：为每条命中事件的配置启动 shell 子进程，
 * 把 JSON 载荷写入 stdin，按「退出码 + 可选 stdout JSON」双协议裁决：
 * - 退出码 0：放行；stdout 若解析为 HookOutcome 则以其为准（支持 block/mutate）
 * - 退出码 2：拦截，stdout 作为拦截原因
 * - 其他退出码 / 超时 / 启动失败：放行并告警——钩子故障不应中断会话
 */
export class ProcessHookRunner implements HookRunner {
  readonly #configs: HookConfig[];
  readonly #options: ProcessHookRunnerOptions;

  constructor(configs: HookConfig[], options: ProcessHookRunnerOptions) {
    this.#configs = configs;
    this.#options = options;
  }

  async preToolUse(call: ToolCallRef): Promise<{ veto: boolean; args?: unknown; reason?: string }> {
    let outcome: { veto: boolean; args?: unknown; reason?: string } = { veto: false };
    for (const result of await this.#runEvent("pre_tool_use", call)) {
      if (result.timedOut || (result.code !== 0 && result.code !== 2)) {
        this.#warn(`pre_tool_use 钩子异常（code=${result.code}），按放行处理：${result.stderr.trim()}`);
        continue;
      }
      if (result.code === 2) {
        return { veto: true, reason: result.stdout.trim() || undefined };
      }
      const parsed = tryParseOutcome(result.stdout);
      if (parsed === undefined) {
        continue;
      }
      if (parsed.action === "block") {
        return { veto: true, reason: parsed.reason };
      }
      if (parsed.action === "mutate" && parsed.args !== undefined) {
        outcome = { veto: false, args: parsed.args };
      }
    }
    return outcome;
  }

  async postToolUse(call: ToolCallRef, result: ToolOutput): Promise<void> {
    await this.#runEvent("post_tool_use", call, { ok: result.ok, error: result.error });
  }

  async onSessionStart(payload: { sessionId: string }): Promise<void> {
    await this.#runEvent("session_start", undefined, payload);
  }

  async onStop(payload: { sessionId: string }): Promise<void> {
    await this.#runEvent("stop", undefined, payload);
  }

  /** 依次执行某事件的全部钩子；单条失败不影响后续 */
  async #runEvent(
    event: HookEventName,
    call?: ToolCallRef,
    extra?: Record<string, unknown>,
  ): Promise<HookExecution[]> {
    const matched = this.#configs.filter((c) => c.event === event);
    const results: HookExecution[] = [];
    for (const config of matched) {
      const payload = {
        event,
        sessionId: this.#options.sessionId,
        ts: Date.now(),
        ...(call !== undefined ? { callId: call.callId, tool: call.tool, args: call.args } : {}),
        ...extra,
      };
      try {
        results.push(await runCommand(config.command, payload, config.timeoutMs ?? DEFAULT_TIMEOUT_MS));
      } catch (err) {
        this.#warn(`钩子启动失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return results;
  }

  #warn(message: string): void {
    this.#options.onWarn?.(message);
  }
}

/** 尝试把 stdout 解析为结构化裁决；非 JSON 或不合法返回 undefined */
function tryParseOutcome(stdout: string): { action: "allow" | "block" | "mutate"; reason?: string; args?: unknown } | undefined {
  const text = stdout.trim();
  if (text === "" || !text.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = HookOutcome.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** 经 shell 执行命令：载荷写 stdin，收集 stdout/stderr，带超时保护 */
function runCommand(command: string, payload: unknown, timeoutMs: number): Promise<HookExecution> {
  return new Promise((resolvePromise, reject) => {
    const shell = shellCommand(command);
    const child = spawn(shell.file, shell.args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
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
      resolvePromise({ code: code ?? -1, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {
      // 目标进程提前退出导致管道断裂：忽略写入错误，等待 close 汇总
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

/**
 * 跨平台 shell 选择：Windows 用 PowerShell（无配置加载），其余用 bash。
 * Windows 侧必须显式 `exit $LASTEXITCODE`——PowerShell 默认把子进程非零退出码改写为 1，
 * 会丢失钩子的退出码 2（拦截）语义。
 */
function shellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", `${command}; exit $LASTEXITCODE`],
    };
  }
  return { file: "bash", args: ["-c", command] };
}

import { spawn } from "node:child_process";
import {
  HookOutcome,
  type HookConfig,
  type HookContextOutcome,
  type HookEventName,
  type HookPreOutcome,
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
  /** fail-closed：超时/失败按拦截处理（B5，安全钩子模式） */
  failClosed: boolean;
}

/** 3-15：两种协议的归一化结果（自有 action 协议 + CC decision/hookSpecificOutput） */
interface ParsedHookResult {
  action: "allow" | "block" | "mutate";
  reason?: string;
  args?: unknown;
  context?: string;
}

/**
 * 进程版钩子执行器：为每条命中事件的配置启动 shell 子进程，
 * 把 JSON 载荷写入 stdin，按「退出码 + 可选 stdout JSON」双协议裁决：
 * - 退出码 0：放行；stdout 若解析为裁决 JSON 则以其为准（支持 block/mutate/additionalContext）
 * - 退出码 2：拦截，stdout（无则 stderr）作为拦截原因——与 CC 的 exit 2 语义对齐
 * - 其他退出码 / 超时 / 启动失败：放行并告警——钩子故障不应中断会话
 *
 * 3-15：`matcher` 只对工具事件生效（工具名或正则，大小写不敏感）；
 * additionalContext 由 pre/post/session_start 汇总后交给 core 注入模型上下文。
 */
export class ProcessHookRunner implements HookRunner {
  readonly #configs: HookConfig[];
  readonly #options: ProcessHookRunnerOptions;
  readonly #warnedMatchers = new Set<string>();

  constructor(configs: HookConfig[], options: ProcessHookRunnerOptions) {
    this.#configs = configs;
    this.#options = options;
  }

  async preToolUse(call: ToolCallRef): Promise<HookPreOutcome> {
    return this.#adjudicate("pre_tool_use", call);
  }

  async onUserPromptSubmit(payload: { sessionId: string; prompt: string }): Promise<HookPreOutcome> {
    return this.#adjudicate("user_prompt_submit", undefined, { prompt: payload.prompt });
  }

  async onPreCompact(payload: { sessionId: string; dropped: number }): Promise<HookPreOutcome> {
    return this.#adjudicate("pre_compact", undefined, { dropped: payload.dropped });
  }

  /** 通用裁决：退出码 2 / stdout block 拦截；mutate 改参；additionalContext 汇总 */
  async #adjudicate(
    event: HookEventName,
    call?: ToolCallRef,
    extra?: Record<string, unknown>,
  ): Promise<HookPreOutcome> {
    let outcome: HookPreOutcome = { veto: false };
    const contexts: string[] = [];
    for (const result of await this.#runEvent(event, call, extra)) {
      if (result.timedOut || (result.code !== 0 && result.code !== 2)) {
        if (result.failClosed) {
          this.#warn(`${event} 钩子失败（code=${result.code}${result.timedOut ? " 超时" : ""}），按 fail-closed 拦截`);
          return { veto: true, reason: `${event} 钩子失败（fail-closed）` };
        }
        this.#warn(
          `${event} 钩子异常（code=${result.code}${result.timedOut ? " 超时" : ""}），按放行处理：${result.stderr.trim()}`,
        );
        continue;
      }
      if (result.code === 2) {
        // CC：exit 2 的 stderr 是回灌给模型的原因；两者都有时优先 stdout（自有协议）
        return { veto: true, reason: result.stdout.trim() || result.stderr.trim() || undefined };
      }
      const parsed = parseHookStdout(result.stdout);
      if (parsed === undefined) {
        continue;
      }
      if (parsed.context !== undefined && parsed.context.trim() !== "") {
        contexts.push(parsed.context.trim());
      }
      if (parsed.action === "block") {
        return { veto: true, reason: parsed.reason };
      }
      if (parsed.action === "mutate" && parsed.args !== undefined) {
        outcome = { veto: false, args: parsed.args };
      }
    }
    if (contexts.length > 0) {
      outcome = { ...outcome, context: contexts.join("\n\n") };
    }
    return outcome;
  }

  async postToolUse(call: ToolCallRef, result: ToolOutput): Promise<HookContextOutcome | void> {
    const results = await this.#runEvent("post_tool_use", call, { ok: result.ok, error: result.error });
    const context = collectContext(results);
    return context === undefined ? undefined : { context };
  }

  async onSessionStart(payload: { sessionId: string }): Promise<HookContextOutcome | void> {
    const results = await this.#runEvent("session_start", undefined, payload);
    const context = collectContext(results);
    return context === undefined ? undefined : { context };
  }

  async onStop(payload: { sessionId: string }): Promise<void> {
    await this.#runEvent("stop", undefined, payload);
  }

  /** 工具名/正则匹配（3-15）：空 = 全部；非工具事件不参与匹配 */
  #matches(matcher: string | undefined, tool: string): boolean {
    if (matcher === undefined || matcher.trim() === "") {
      return true;
    }
    if (matcher.toLowerCase() === tool.toLowerCase()) {
      return true;
    }
    try {
      return new RegExp(matcher, "i").test(tool);
    } catch {
      if (!this.#warnedMatchers.has(matcher)) {
        this.#warnedMatchers.add(matcher);
        this.#warn(`matcher 不是合法正则：${matcher}（按不匹配处理）`);
      }
      return false;
    }
  }

  /** 依次执行某事件的全部钩子；单条失败不影响后续 */
  async #runEvent(
    event: HookEventName,
    call?: ToolCallRef,
    extra?: Record<string, unknown>,
  ): Promise<HookExecution[]> {
    const matched = this.#configs.filter(
      (c) => c.event === event && (call === undefined || this.#matches(c.matcher, call.tool)),
    );
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
        const exec = await runCommand(config.command, payload, config.timeoutMs ?? DEFAULT_TIMEOUT_MS, config.cwd);
        results.push({ ...exec, failClosed: config.failClosed === true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.#warn(`钩子启动失败：${message}`);
        results.push({ code: -1, stdout: "", stderr: message, timedOut: false, failClosed: config.failClosed === true });
      }
    }
    return results;
  }

  #warn(message: string): void {
    this.#options.onWarn?.(message);
  }
}

/** 汇总所有钩子 stdout 里的 additionalContext（3-15） */
function collectContext(results: HookExecution[]): string | undefined {
  const parts: string[] = [];
  for (const result of results) {
    const parsed = parseHookStdout(result.stdout);
    if (parsed?.context !== undefined && parsed.context.trim() !== "") {
      parts.push(parsed.context.trim());
    }
  }
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * stdout JSON 双协议解析（3-15）：
 * - 自有：`{ action: "allow"|"block"|"mutate", reason?, args?, additionalContext? }`
 * - CC：`{ decision: "approve"|"block", reason? }`、
 *   `{ continue: false, stopReason? }`、
 *   `{ hookSpecificOutput: { permissionDecision?: "allow"|"deny"|"ask", permissionDecisionReason?, additionalContext? } }`
 * 未知 JSON（无上述字段）返回 undefined（按放行，不误判）。
 */
export function parseHookStdout(stdout: string): ParsedHookResult | undefined {
  const source = stdout.trim();
  if (source === "" || !source.startsWith("{")) {
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    return undefined;
  }
  const record = asRecord(data);
  if (record === null) {
    return undefined;
  }
  // 自有协议先走 schema 校验（严格，避免把 CC 结构误判为自有结构）
  const own = HookOutcome.safeParse(record);
  if (own.success) {
    return {
      action: own.data.action,
      ...(own.data.reason !== undefined ? { reason: own.data.reason } : {}),
      ...(own.data.args !== undefined ? { args: own.data.args } : {}),
      ...(own.data.additionalContext !== undefined ? { context: own.data.additionalContext } : {}),
    };
  }
  const topContext = text(record["additionalContext"]);
  const specific = asRecord(record["hookSpecificOutput"]);
  const reason = text(specific?.["permissionDecisionReason"]);
  const context = topContext ?? text(specific?.["additionalContext"]);
  if (specific !== null) {
    const decision = specific["permissionDecision"];
    if (decision === "deny") {
      return { action: "block", ...(reason !== undefined ? { reason } : {}) };
    }
    if (decision === "ask") {
      return { action: "block", reason: reason ?? "hook requires confirmation" };
    }
    if (decision === "allow") {
      return { action: "allow", ...(context !== undefined ? { context } : {}) };
    }
  }

  if (record["continue"] === false) {
    const stopReason = text(record["stopReason"]);
    return { action: "block", ...(stopReason !== undefined ? { reason: stopReason } : {}) };
  }
  const ccDecision = record["decision"];
  if (ccDecision === "block") {
    return { action: "block", ...(text(record["reason"]) !== undefined ? { reason: text(record["reason"])! } : {}) };
  }
  if (ccDecision === "approve") {
    return { action: "allow", ...(context !== undefined ? { context } : {}) };
  }
  if (context !== undefined) {
    return { action: "allow", context };
  }
  return undefined;
}

/** 经 shell 执行命令：载荷写 stdin，收集 stdout/stderr，带超时保护 */
function runCommand(command: string, payload: unknown, timeoutMs: number, cwd?: string): Promise<HookExecution> {
  return new Promise((resolvePromise, reject) => {
    const shell = shellCommand(command);
    const child = spawn(shell.file, shell.args, {
      windowsHide: true,
      detached: process.platform !== "win32",
      ...(cwd !== undefined ? { cwd } : {}),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let fallback: NodeJS.Timeout | undefined;
    const settle = (code: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (fallback !== undefined) clearTimeout(fallback);
      resolvePromise({ code, stdout, stderr, timedOut, failClosed: false });
    };
    timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined && process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        killer.on("error", () => child.kill());
      } else if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill();
      }
      // 兜底：Windows 上孙进程可能短暂持有 stdout 管道，close 迟迟不来——
      // 超时语义必须可靠（否则一次钩子超时会把整轮会话挂死），到点强制结算。
      fallback = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // 已退出
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(-1);
      }, 1_500);
      fallback.unref?.();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (fallback !== undefined) clearTimeout(fallback);
      reject(err);
    });
    child.on("close", (code) => {
      settle(code ?? -1);
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

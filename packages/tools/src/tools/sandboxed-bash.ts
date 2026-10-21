import { join, isAbsolute, relative, resolve } from "node:path";
import type { SandboxExecutionInfo, SandboxMode, SandboxPort, SandboxResult } from "@kcode/contracts";
import { OutputCollector, type OutputLimits } from "./output-collector.js";
import { extractShellSnapshot, markCommandForSnapshot } from "./shell-snapshot.js";

/**
 * 4-01：前台 shell 的沙箱路径（从 bash.ts 外迁，避免工具主文件继续膨胀）。
 * 只在 opts.sandbox 存在时调用；沙箱不可用绝不回退到无沙箱执行。
 */
export interface SandboxedBashOptions {
  sandbox: SandboxPort;
  command: string;
  /** shell 名（bash/powershell）用于 cwd 打点语法 */
  shellName: "bash" | "powershell";
  /** shell 可执行文件，交给 srt 选择 */
  shellFile: string;
  workDir: string;
  env: NodeJS.ProcessEnv;
  mode: SandboxMode;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  sessionCwd: string | undefined;
  artifactsDir: string | undefined;
  callId: string | undefined;
  outputLimits: Partial<OutputLimits> | undefined;
}

export interface SandboxedBashOutcome {
  text: string;
  code: number;
  timedOut: boolean;
  aborted: boolean;
  /** undefined = 无快照；null = 越界重置；string = 新持久目录 */
  nextCwd: string | null | undefined;
  error?: string;
  /** 4-01：给 ToolOutput/审计的沙箱事实 */
  sandbox: SandboxExecutionInfo;
}

function sandboxInfo(result: SandboxResult, mode: SandboxMode): SandboxExecutionInfo {
  return {
    backend: result.backend,
    sandboxed: result.sandboxed,
    mode,
    ...(result.denied !== undefined ? { denied: result.denied } : {}),
  };
}

/** 与 bash.ts 同口径的项目边界判断（避免 helper ↔ bash 循环依赖） */
function isWithinPath(base: string, target: string): boolean {
  const norm = (p: string): string => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(norm(base), norm(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function msysPathToWin32(p: string): string {
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
  const drive = m?.[1];
  const rest = m?.[2];
  if (m === null || drive === undefined || rest === undefined) return p;
  return `${drive.toUpperCase()}:\\${rest.replace(/\//g, "\\")}`;
}

export async function runSandboxedBash(opts: SandboxedBashOptions): Promise<SandboxedBashOutcome> {
  const nonce = Math.random().toString(36).slice(2, 12);
  const collector = new OutputCollector(
    opts.outputLimits,
    opts.artifactsDir !== undefined && opts.callId !== undefined
      ? join(opts.artifactsDir, `${opts.callId}.log`)
      : undefined,
  );

  const result = await opts.sandbox.run({
    command: markCommandForSnapshot(opts.shellName, opts.command, nonce),
    cwd: opts.workDir,
    shell: opts.shellFile,
    env: opts.env,
    mode: opts.mode,
    network: "deny",
    timeoutMs: opts.timeoutMs,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  if (!result.sandboxed) {
    return {
      text: result.stderr,
      code: result.exitCode,
      timedOut: result.timedOut,
      aborted: false,
      nextCwd: undefined,
      error: `沙箱未生效，已拒绝执行（${result.backend}）：${result.stderr || "unknown"}`,
      sandbox: sandboxInfo(result, opts.mode),
    };
  }

  collector.append(result.stdout);
  collector.append(result.stderr);
  const snapshot = extractShellSnapshot(collector.getText(), nonce);
  const finished = await collector.finish((text) => extractShellSnapshot(text, nonce).output);

  let nextCwd: string | null | undefined;
  let boundaryNote = "";
  if (snapshot.cwd !== undefined) {
    const candidate = process.platform === "win32" ? msysPathToWin32(snapshot.cwd) : snapshot.cwd;
    if (opts.sessionCwd === undefined || isWithinPath(opts.sessionCwd, candidate)) {
      nextCwd = candidate;
    } else {
      nextCwd = null;
      boundaryNote = `\n⚠ 工作目录已离开项目（${candidate}）——持久目录重置回 ${opts.sessionCwd}；操作系统外路径请每次显式 cd 或用绝对路径`;
    }
  }

  return {
    text: boundaryNote === "" ? finished.text : `${finished.text}${boundaryNote}`,
    code: result.exitCode,
    timedOut: result.timedOut,
    aborted: opts.signal?.aborted === true,
    nextCwd,
    sandbox: sandboxInfo(result, opts.mode),
  };
}

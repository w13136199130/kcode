/**
 * 沙箱执行端口（4-01 / M1）。
 *
 * 这里只放跨包契约，不出现 srt / MXC 的类型：
 * tools 依赖 SandboxPort，sandbox 实现适配器，session 负责注入。
 */
export type SandboxMode = "read-only" | "workspace-write";
export type SandboxBackendId = "srt" | "mxc" | "none";

export interface SandboxRequest {
  /** 已由调用方拼接好的 shell 命令（含 cwd 打点等） */
  command: string;
  cwd: string;
  /** shell 可执行文件或名称（如 bash / powershell.exe） */
  shell: string;
  /** 已清洗的环境变量（不依赖 NodeJS 类型，web 端也可 import 契约） */
  env: Readonly<Record<string, string | undefined>>;
  mode: SandboxMode;
  network: "deny" | "allowlist";
  allowedHosts?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SandboxDenial {
  kind: "path" | "network";
  target: string;
  operation?: "read" | "write" | "connect";
}

/** 工具结果带给审计的沙箱事实：不改变命令输出，只让 /audit 能区分是否真的在沙箱里 */
export interface SandboxExecutionInfo {
  backend: SandboxBackendId;
  sandboxed: boolean;
  mode?: SandboxMode;
  denied?: SandboxDenial;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** false 表示实际没有沙箱化——调用方必须显式处理，不能静默当成功 */
  sandboxed: boolean;
  backend: SandboxBackendId;
  denied?: SandboxDenial;
  warnings?: string[];
}

export interface SandboxAvailability {
  available: boolean;
  backend: SandboxBackendId;
  reason?: string;
}

/** tools 只依赖这个端口；srt/MXC 细节在 @kcode/sandbox 内 */
export interface SandboxPort {
  readonly id: SandboxBackendId;
  available(): Promise<SandboxAvailability>;
  run(request: SandboxRequest): Promise<SandboxResult>;
}

import type {
  SandboxAvailability,
  SandboxPort,
  SandboxRequest,
  SandboxResult,
} from "@kcode/contracts";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { policyFor } from "../policy.js";

/**
 * MXC adapter（M1：run/spawn 路径；PTY 另由 pty 层接入）。
 *
 * 运行时动态 import：MXC 1.x 要求 Node >=24，当前 Node 22 只应显示
 * “不可用”，不能让整个 CLI 在启动时加载 native SDK。
 */
export class MxcSandbox implements SandboxPort {
  readonly id = "mxc" as const;
  #availability: Promise<SandboxAvailability> | undefined;

  available(): Promise<SandboxAvailability> {
    this.#availability ??= this.#probe();
    return this.#availability;
  }

  async #probe(): Promise<SandboxAvailability> {
    const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
    if (major < 24) {
      return {
        available: false,
        backend: "mxc",
        reason: `MXC 需要 Node >=24（当前 ${process.versions.node}）`,
      };
    }
    try {
      const mod = await import("@microsoft/mxc-sdk/v1");
      const support = mod.getPlatformSupport();
      return support.isSupported
        ? { available: true, backend: "mxc" }
        : { available: false, backend: "mxc", reason: support.reason ?? "MXC 不支持当前主机" };
    } catch (err) {
      return {
        available: false,
        backend: "mxc",
        reason: `MXC SDK 不可用：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async run(request: SandboxRequest): Promise<SandboxResult> {
    try {
      const mod = await import("@microsoft/mxc-sdk/v1");
      const proc = await mod.spawn(mxcRequest(request));
      let stdout = "";
      let stderr = "";
      proc.standardOutput?.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString();
        stdout += text;
        request.onOutput?.(text);
      });
      proc.standardError?.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString();
        stderr += text;
        request.onOutput?.(text);
      });
      const onAbort = (): void => proc.kill();
      request.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await proc.wait();
        return {
          exitCode: result.exitCode,
          stdout,
          stderr,
          timedOut: result.timedOut,
          sandboxed: true,
          backend: "mxc",
          ...(proc.warnings.length > 0 ? { warnings: [...proc.warnings] } : {}),
        };
      } finally {
        request.signal?.removeEventListener("abort", onAbort);
        proc.dispose();
      }
    } catch (err) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `MXC 启动失败：${err instanceof Error ? err.message : String(err)}`,
        timedOut: false,
        sandboxed: false,
        backend: "mxc",
      };
    }
  }
}

/**
 * 纯映射，便于不加载 native SDK 的单元测试。
 * allowWrite/allowRead 是路径语义；MXC 用 readwritePaths/readonlyPaths。
 */
export function mxcRequest(request: SandboxRequest): ContainerRequest {
  const policy = policyFor(request);
  return {
    command: request.command,
    workingDirectory: request.cwd,
    timeoutMs: request.timeoutMs,
    // Host-native process backend; MXC selects AppContainer/Seatbelt/bwrap.
    ui: { disable: true },
    filesystem:
      request.mode === "workspace-write"
        ? { readwritePaths: [request.cwd], deniedPaths: policy.denyRead }
        : { readonlyPaths: [request.cwd], deniedPaths: policy.denyRead },
    network: { egress: { default: "deny" } },
    environment: { ...request.env },
    inheritDefaultEnvironment: false,
  };
}

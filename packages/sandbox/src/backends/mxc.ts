import type { SandboxAvailability, SandboxPort, SandboxRequest, SandboxResult } from "@kcode/contracts";

/**
 * MXC 适配器占位：接口先固定，等 kcode 升 Node 24 且目标主机
 * `getPlatformSupport().isSupported` 后再实现。
 *
 * 不在这里 import @microsoft/mxc-sdk，避免 Node 22/大依赖阻塞当前 srt 落地。
 */
export class MxcSandbox implements SandboxPort {
  readonly id = "mxc" as const;

  async available(): Promise<SandboxAvailability> {
    return {
      available: false,
      backend: "mxc",
      reason: "MXC backend 尚未接入（需要 Node >=24.21 且主机支持 MXC/PSEC）",
    };
  }

  async run(request: SandboxRequest): Promise<SandboxResult> {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `MXC backend unavailable: ${request.command}`,
      timedOut: false,
      sandboxed: false,
      backend: "mxc",
    };
  }
}

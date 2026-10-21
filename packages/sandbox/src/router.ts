import type { SandboxAvailability, SandboxBackendId, SandboxPort, SandboxRequest, SandboxResult } from "@kcode/contracts";
import { MxcSandbox } from "./backends/mxc.js";
import { SrtSandbox } from "./backends/srt.js";

export type SandboxSetting = "auto" | "srt" | "mxc" | "off";

export function sandboxSetting(env: NodeJS.ProcessEnv = process.env): SandboxSetting {
  const value = env["KCODE_SANDBOX"]?.trim();
  return value === "srt" || value === "mxc" || value === "auto" ? value : "off";
}

/**
 * 后端路由：只在这里选择 srt/MXC，tools 不感知。
 * 显式请求的后端不可用时 fail-closed，绝不静默跑无沙箱命令。
 */
export class SandboxRouter implements SandboxPort {
  readonly id: SandboxBackendId;
  readonly #backends: readonly SandboxPort[];

  constructor(backends: readonly SandboxPort[]) {
    this.#backends = backends;
    this.id = backends[0]?.id ?? "none";
  }

  async available(): Promise<SandboxAvailability> {
    const reasons: string[] = [];
    for (const backend of this.#backends) {
      const status = await backend.available();
      if (status.available) return status;
      if (status.reason !== undefined) reasons.push(status.reason);
    }
    return {
      available: false,
      backend: "none",
      ...(reasons.length > 0 ? { reason: reasons.join("；") } : {}),
    };
  }

  async run(request: SandboxRequest): Promise<SandboxResult> {
    for (const backend of this.#backends) {
      const status = await backend.available();
      if (!status.available) continue;
      return backend.run(request);
    }
    const status = await this.available();
    return {
      exitCode: 1,
      stdout: "",
      stderr: `sandbox unavailable: ${status.reason ?? "no backend"}`,
      timedOut: false,
      sandboxed: false,
      backend: "none",
    };
  }
}

/** off 返回 undefined（调用方走原路径）；显式/auto 返回 router。 */
export function createSandboxPort(env: NodeJS.ProcessEnv = process.env): SandboxPort | undefined {
  const setting = sandboxSetting(env);
  if (setting === "off") return undefined;
  if (setting === "srt") return new SandboxRouter([new SrtSandbox()]);
  if (setting === "mxc") return new SandboxRouter([new MxcSandbox()]);
  return new SandboxRouter([new MxcSandbox(), new SrtSandbox()]);
}

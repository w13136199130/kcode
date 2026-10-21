import type { SandboxAvailability, SandboxPort, SandboxRequest, SandboxResult } from "@kcode/contracts";

/** 显式关闭：不提供沙箱能力；Router 会在 run 时 fail-closed，而不是静默放行。 */
export class NoneSandbox implements SandboxPort {
  readonly id = "none" as const;

  async available(): Promise<SandboxAvailability> {
    return { available: false, backend: "none", reason: "sandbox disabled (KCODE_SANDBOX=off)" };
  }

  async run(request: SandboxRequest): Promise<SandboxResult> {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `sandbox disabled: ${request.command}`,
      timedOut: false,
      sandboxed: false,
      backend: "none",
    };
  }
}

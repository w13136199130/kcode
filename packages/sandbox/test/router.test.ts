import { describe, expect, it } from "vitest";
import type { SandboxAvailability, SandboxPort, SandboxRequest, SandboxResult } from "@kcode/contracts";
import { SandboxRouter, createSandboxPort, sandboxSetting } from "../src/index.js";

function fake(
  id: "srt" | "mxc",
  available: boolean,
  result?: Partial<SandboxResult>,
): SandboxPort & { calls: SandboxRequest[] } {
  const calls: SandboxRequest[] = [];
  return {
    id,
    calls,
    async available(): Promise<SandboxAvailability> {
      return available ? { available: true, backend: id } : { available: false, backend: id, reason: `${id} unavailable` };
    },
    async run(request: SandboxRequest): Promise<SandboxResult> {
      calls.push(request);
      return {
        exitCode: 0,
        stdout: id,
        stderr: "",
        timedOut: false,
        sandboxed: true,
        backend: id,
        ...result,
      };
    },
  };
}

const request: SandboxRequest = {
  command: "echo hi",
  cwd: process.cwd(),
  shell: "bash",
  env: {},
  mode: "workspace-write",
  network: "deny",
};

describe("SandboxRouter（4-01）", () => {
  it("默认 off：不注入沙箱（原路径）", () => {
    expect(sandboxSetting({})).toBe("off");
    expect(createSandboxPort({})).toBeUndefined();
  });

  it("显式 srt/auto 选择；auto 优先可用后端", async () => {
    expect(sandboxSetting({ KCODE_SANDBOX: "srt" })).toBe("srt");
    const mxc = fake("mxc", false);
    const srt = fake("srt", true);
    const router = new SandboxRouter([mxc, srt]);
    const result = await router.run(request);
    expect(result.backend).toBe("srt");
    expect(mxc.calls).toHaveLength(0);
    expect(srt.calls).toHaveLength(1);
  });

  it("全部不可用：fail-closed，不静默放行", async () => {
    const router = new SandboxRouter([fake("srt", false), fake("mxc", false)]);
    const result = await router.run(request);
    expect(result.sandboxed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("sandbox unavailable");
  });

  it("后端返回 sandboxed=false 时调用方能看到（不伪装成功）", async () => {
    const router = new SandboxRouter([fake("srt", true, { sandboxed: false, stderr: "denied" })]);
    const result = await router.run(request);
    expect(result.sandboxed).toBe(false);
    expect(result.stderr).toContain("denied");
  });
});

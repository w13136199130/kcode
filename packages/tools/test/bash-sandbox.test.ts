import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SandboxPort, SandboxRequest, SandboxResult } from "@kcode/contracts";
import { createBashTool } from "@kcode/tools";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-bash-sandbox-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

class FakeSandbox implements SandboxPort {
  readonly id = "srt" as const;
  readonly calls: SandboxRequest[] = [];
  constructor(
    private readonly result: Partial<SandboxResult> = {},
    private readonly stream = false,
  ) {}

  async available() {
    return { available: true, backend: this.id } as const;
  }

  async run(request: SandboxRequest): Promise<SandboxResult> {
    this.calls.push(request);
    if (this.stream) {
      request.onOutput?.("streamed-line\n");
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        sandboxed: true,
        backend: "srt",
        ...this.result,
      };
    }
    return {
      exitCode: 0,
      stdout: "sandboxed-output\n",
      stderr: "",
      timedOut: false,
      sandboxed: true,
      backend: "srt",
      ...this.result,
    };
  }
}

const ctx = () => ({ sessionId: "s", cwd: root });

describe("bash 沙箱接入（4-01）", () => {
  it("前台命令走 SandboxPort，输出归一化", async () => {
    const sandbox = new FakeSandbox();
    const bash = createBashTool({ sessionId: "s", artifactsDir: join(root, "art"), sandbox });
    const result = await bash.execute({ command: "echo hi" }, ctx());
    expect(result.ok).toBe(true);
    expect(result.output).toContain("sandboxed-output");
    expect(result.sandbox).toMatchObject({ backend: "srt", sandboxed: true, mode: "workspace-write" });
    expect(sandbox.calls).toHaveLength(1);
    expect(sandbox.calls[0]?.command).toContain("__kcode_pwd_");
  });

  it("流式输出只 append 一次，不重复终态 stdout", async () => {
    const sandbox = new FakeSandbox({}, true);
    const bash = createBashTool({ sessionId: "s", sandbox });
    const result = await bash.execute({ command: "echo stream" }, ctx());
    expect(result.ok).toBe(true);
    expect(result.output).toBe("streamed-line\n");
  });

  it("沙箱拒绝路径 → ok=false 且带 denied 审计事实", async () => {
    const sandbox = new FakeSandbox({
      exitCode: 0,
      denied: { kind: "path", target: "C:\\Windows\\secret.txt", operation: "write" },
    });
    const bash = createBashTool({ sessionId: "s", sandbox });
    const result = await bash.execute({ command: "echo nope > C:\\Windows\\secret.txt" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("沙箱拒绝");
    expect(result.sandbox?.denied).toEqual({
      kind: "path",
      target: "C:\\Windows\\secret.txt",
      operation: "write",
    });
  });

  it("沙箱未生效时 fail-closed，不执行原命令", async () => {
    const sandbox = new FakeSandbox({ sandboxed: false, stderr: "sandbox unavailable", exitCode: 1 });
    const bash = createBashTool({ sessionId: "s", sandbox });
    const result = await bash.execute({ command: "echo should-not-run" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("沙箱未生效");
    expect(result.output).not.toContain("should-not-run");
  });

  it("后台任务 + 沙箱：明确拒绝，不回退无沙箱", async () => {
    const sandbox = new FakeSandbox();
    const bash = createBashTool({ sessionId: "s", artifactsDir: join(root, "art"), sandbox });
    const result = await bash.execute({ command: "echo bg", runInBackground: true }, ctx());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("暂不支持后台任务");
    expect(sandbox.calls).toHaveLength(0);
  });
});

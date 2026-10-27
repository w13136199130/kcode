import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SrtSandbox } from "../src/index.js";

/**
 * Opt-in Windows integration check. Requires srt installed:
 *   scripts/srt-sandbox.ps1 -Action install
 *   $env:KCODE_SRT_LIVE="1"
 * Not run in CI (machine-level install).
 */
describe("srt live adapter", () => {
  it.skipIf(process.env["KCODE_SRT_LIVE"] !== "1")("launches a command through SandboxPort", async () => {
    const sandbox = new SrtSandbox();
    // Fixed cwd: srt keeps a persistent write root per path; random deleted
    // temp roots make the next ACL grant wait on a missing volume.
    const cwd = join(tmpdir(), "kcode-srt-live");
    await mkdir(cwd, { recursive: true });
    const result = await sandbox.run({
      command: "echo KCODE_SRT_ADAPTER_OK",
      cwd,
      shell: "powershell.exe",
      env: {},
      mode: "workspace-write",
      network: "deny",
      timeoutMs: 30_000,
    });
    expect(result.sandboxed).toBe(true);
    expect(result.stdout).toContain("KCODE_SRT_ADAPTER_OK");
    expect(result.exitCode).toBe(0);
  }, 60_000);
});

/**
 * S3-1 真实验收（env KCODE_SRT_LIVE=1，本机实跑；CI 无 srt 安装自动跳过）：
 * bash 工具 → SandboxPort → 真实 srt。三场景对齐优化文档验收清单——
 * ① 工作区可写 ② 系统目录写被拒且提示可见 ③ 出网被断（WFP）。
 */

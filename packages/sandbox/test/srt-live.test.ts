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
describe.skipIf(process.env["KCODE_SRT_LIVE"] !== "1")("srt live × bash 工具验收（S3-1）", () => {
  // 注意：kcode 沙箱 bash 经 srt 的 run.sh 以 POSIX shell 执行——命令必须 POSIX 化
  const cwd = join(tmpdir(), "kcode-srt-accept");
  it(
    "① 工作区写通过 bash 工具成功落盘",
    async () => {
      const { createBashTool } = await import("@kcode/tools");
      const bash = createBashTool({ sessionId: "srt-accept", artifactsDir: join(cwd, "art"), sandbox: new SrtSandbox() });
      const result = await bash.execute(
        { command: "echo srt-ok > accept.txt && cat accept.txt" },
        { sessionId: "srt-accept", cwd },
      );
      expect(result.ok).toBe(true);
      expect(result.output).toContain("srt-ok");
      expect(result.sandbox?.sandboxed).toBe(true);
    },
    120_000,
  );

  it(
    "② 写系统目录被拒：ok=false、错误可见、目标文件确实未产生",
    async () => {
      const { createBashTool } = await import("@kcode/tools");
      const bash = createBashTool({ sessionId: "srt-accept", sandbox: new SrtSandbox() });
      const result = await bash.execute(
        { command: 'echo nope > "C:/Windows/kcode-srt-accept.txt" && echo WROTE' },
        { sessionId: "srt-accept", cwd },
      );
      expect(result.ok).toBe(false);
      expect(result.output).not.toContain("WROTE");
      const { access } = await import("node:fs/promises");
      const leaked = await access("C:\Windows\kcode-srt-accept.txt").then(() => true, () => false);
      expect(leaked).toBe(false);
    },
    120_000,
  );

  it(
    "③ 出网被断（WFP deny）：curl 失败非 0 且无响应体",
    async () => {
      const { createBashTool } = await import("@kcode/tools");
      const bash = createBashTool({ sessionId: "srt-accept", sandbox: new SrtSandbox() });
      const result = await bash.execute(
        { command: "curl -sS --max-time 15 https://example.com" },
        { sessionId: "srt-accept", cwd },
      );
      expect(result.ok).toBe(false);
      expect((result.output ?? "")).not.toContain("<html");
    },
    120_000,
  );
});

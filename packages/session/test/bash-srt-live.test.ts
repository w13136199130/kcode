import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBashTool } from "@kcode/tools";
import { SrtSandbox } from "@kcode/sandbox";

/**
 * S3-1 真实验收（env KCODE_SRT_LIVE=1，本机实跑；CI 无 srt 安装自动跳过）。
 * 放在 session 层：合法依赖 tools（bash 工具）与 sandbox（真实后端）——sandbox 包
 * 不能反向 import tools（依赖方向见 srt-sandbox.md §4）。
 * 命令必须 POSIX 化：沙箱 bash 经 srt run.sh 以 POSIX shell 执行（§2.5）。
 */
describe.skipIf(process.env["KCODE_SRT_LIVE"] !== "1")("srt live × bash 工具验收（S3-1）", () => {
  const cwd = join(tmpdir(), "kcode-srt-accept");

  it(
    "① 工作区写通过 bash 工具成功落盘",
    async () => {
      await mkdir(cwd, { recursive: true });
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
      const bash = createBashTool({ sessionId: "srt-accept", sandbox: new SrtSandbox() });
      const result = await bash.execute(
        { command: 'echo nope > "C:/Windows/kcode-srt-accept.txt" && echo WROTE' },
        { sessionId: "srt-accept", cwd },
      );
      expect(result.ok).toBe(false);
      expect(result.output).not.toContain("WROTE");
      const { access } = await import("node:fs/promises");
      const leaked = await access("C:\Windows\kcode-srt-accept.txt").then(
        () => true,
        () => false,
      );
      expect(leaked).toBe(false);
    },
    120_000,
  );

  it(
    "③ 出网被断（WFP deny）：curl 失败非 0 且无响应体",
    async () => {
      const bash = createBashTool({ sessionId: "srt-accept", sandbox: new SrtSandbox() });
      const result = await bash.execute(
        { command: "curl -sS --max-time 15 https://example.com" },
        { sessionId: "srt-accept", cwd },
      );
      expect(result.ok).toBe(false);
      expect(result.output ?? "").not.toContain("<html");
    },
    120_000,
  );
});

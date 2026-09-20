import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBashTool, currentShellInfo } from "../src/index.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-bash-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const ctx = (): { sessionId: string; cwd: string } => ({ sessionId: "s", cwd: root });

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("bash 工具", () => {
  it("前台执行并捕获输出", async () => {
    const bash = createBashTool({ sessionId: "s", artifactsDir: join(root, "art") });
    const r = await bash.execute({ command: "echo kcode-bash-ok" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("kcode-bash-ok");
  });

  it("非零退出码 → ok=false 且带 exit code", async () => {
    const bash = createBashTool({ sessionId: "s", artifactsDir: join(root, "art") });
    const r = await bash.execute({ command: "exit 3" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("exit code 3");
  });

  it("超时终止并报错", async () => {
    const bash = createBashTool({ sessionId: "s", artifactsDir: join(root, "art") });
    const command = "sleep 5";
    const r = await bash.execute({ command, timeoutMs: 800 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("超时");
  });

  it("后台任务：立即返回任务号，日志落盘，完成通知触发", async () => {
    const notices: string[] = [];
    const artifacts = join(root, "art-bg");
    const bash = createBashTool({
      sessionId: "s",
      artifactsDir: artifacts,
      onNotice: (m) => {
        notices.push(m);
      },
    });
    const r = await bash.execute({ command: "echo bg-done-42", runInBackground: true }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("bg_");
    const logPath = r.output.split("日志：")[1] ?? "";

    await waitFor(() => notices.length > 0);
    expect(notices[0]).toContain("完成");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("bg-done-42");
  });

  it("非法参数被拒绝", async () => {
    const bash = createBashTool({ sessionId: "s", artifactsDir: join(root, "art") });
    const r = await bash.execute({ wrong: true }, ctx());
    expect(r.ok).toBe(false);
  });

  it("currentShellInfo：win32 下探测到 shell 并与描述一致", async () => {
    const info = currentShellInfo();
    if (process.platform === "win32") {
      expect(["bash", "powershell"]).toContain(info.name);
    } else {
      expect(info.name).toBe("bash");
    }
    const bash = createBashTool({ sessionId: "s", artifactsDir: join(root, "art") });
    expect(bash.definition.description).toContain(
      info.name === "bash" ? "bash 语法" : "PowerShell 语法",
    );
  });

  it("bash 语法命令在当前 shell 下直接可用（git-bash 优先的证据）", async () => {
    const bash = createBashTool({ sessionId: "s", artifactsDir: join(root, "art") });
    // bash 语法：$() 展开与 && 链；PowerShell 5.1 对 $(...) 部分兼容但 `2>/dev/null` 不兼容
    if (currentShellInfo().name !== "bash") {
      return; // 无 bash 的环境跳过（仅验证 bash 路径）
    }
    const r = await bash.execute(
      { command: "echo \"ver=$(echo 1)\" && echo line2 2>/dev/null" },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("ver=1");
    expect(r.output).toContain("line2");
  });
});

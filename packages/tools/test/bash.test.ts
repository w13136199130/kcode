import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBashTool, currentShellInfo, pickBashCandidates } from "../src/index.js";

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

  it("中断信号杀掉运行中的命令（不再等超时）", async () => {
    const bash = createBashTool({ sessionId: "s", artifactsDir: join(root, "art") });
    const controller = new AbortController();
    const started = Date.now();
    const pending = bash.execute(
      { command: "sleep 30", timeoutMs: 60_000 },
      { sessionId: "s", cwd: root, signal: controller.signal },
    );
    await new Promise((r) => setTimeout(r, 400));
    controller.abort();
    const r = await pending;
    const elapsed = Date.now() - started;
    expect(r.ok).toBe(false);
    expect(elapsed).toBeLessThan(10_000); // 没等到 60s 超时
    expect(r.output).toContain("已被用户中断");
  });

  it("非法参数被拒绝", async () => {
    const bash = createBashTool({ sessionId: "s", artifactsDir: join(root, "art") });
    const r = await bash.execute({ wrong: true }, ctx());
    expect(r.ok).toBe(false);
  });

  it("currentShellInfo：win32 下探测到 shell（跳过 WSL 后探针验证）", async () => {
    const info = await currentShellInfo();
    if (process.platform === "win32") {
      expect(["bash", "powershell"]).toContain(info.name);
    } else {
      expect(info.name).toBe("bash");
    }
    const bash = createBashTool({ sessionId: "s", artifactsDir: join(root, "art") });
    expect(bash.definition.description).toContain("bash");
  });

  it("pickBashCandidates：跳过 \\Windows\\（WSL 启动器）目录", () => {
    const picked = pickBashCandidates(
      [
        "C:\\Windows\\System32",
        "C:\\WINDOWS",
        "D:\\git\\usr\\bin",
        "",
        "C:\\Windows\\System32", // 重复也去重
      ],
      () => true, // 存在性注入：测试只验证过滤/去重逻辑
    );
    expect(picked).toEqual([join("D:\\git\\usr\\bin", "bash.exe")]);
  });

  it("bash 语法命令在当前 shell 下直接可用（git-bash 优先的证据）", async () => {
    const bash = createBashTool({ sessionId: "s", artifactsDir: join(root, "art") });
    // bash 语法：$() 展开与 && 链；PowerShell 5.1 对 $(...) 部分兼容但 `2>/dev/null` 不兼容
    if ((await currentShellInfo()).name !== "bash") {
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

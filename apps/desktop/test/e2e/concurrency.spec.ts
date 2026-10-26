import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const cwd = fileURLToPath(new URL("../..", import.meta.url));
const kcodePath = "E:/space/my_space/MyProject/kcode";

test("CLI/其他进程新会话通过目录监听即时出现在侧栏", async () => {
  test.setTimeout(60_000);
  const fakeHome = await mkdtemp(join(tmpdir(), "kcode-desktop-concurrency-"));
  const kcodeHome = join(fakeHome, ".kcode");
  const sessions = join(kcodeHome, "cli", "sessions");
  await mkdir(sessions, { recursive: true });
  await mkdir(join(kcodeHome, "desktop"), { recursive: true });
  await writeFile(
    join(kcodeHome, "config.json"),
    JSON.stringify({
      models: {
        default: "mock/model",
        providers: { mock: { type: "openai-compatible", baseURL: "https://example.com/v1" } },
      },
    }),
    "utf8",
  );
  await writeFile(
    join(kcodeHome, "desktop", "projects.json"),
    JSON.stringify({
      version: 1,
      workspaces: [{ path: kcodePath, name: "kcode", createdAt: Date.now(), updatedAt: Date.now() }],
    }),
    "utf8",
  );
  const env = {
    ...process.env,
    KCODE_HOME: kcodeHome,
    KCODE_DESKTOP_USER_DATA: join(fakeHome, "userData"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: ["dist/main.cjs", "--headless", "--no-sandbox", "--disable-gpu"],
    cwd,
    env,
  });
  const page = await app.firstWindow({ timeout: 20_000 });
  await page.addInitScript((value) => localStorage.setItem("kcode-last-cwd", value), kcodePath);
  await page.reload();
  await expect(page.locator(".desktop-v2")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".composer-input")).toBeEnabled({ timeout: 20_000 });

  const now = Date.now();
  await writeFile(
    join(sessions, "sess_cli_concurrent.jsonl"),
    [
      JSON.stringify({
        v: 1,
        type: "session_start",
        ts: now,
        sessionId: "sess_cli_concurrent",
        model: "mock/model",
        workspaceKey: kcodePath,
      }),
      JSON.stringify({ v: 1, type: "user_message", ts: now + 1, sessionId: "sess_cli_concurrent", content: "CLI 并发会话" }),
      JSON.stringify({ v: 1, type: "assistant_message", ts: now + 2, sessionId: "sess_cli_concurrent", content: "ok" }),
    ].join("\n") + "\n",
    "utf8",
  );

  await expect(page.locator(".d2-task").filter({ hasText: "CLI 并发会话" })).toBeVisible({ timeout: 10_000 });

  const pid = app.process().pid;
  if (pid !== undefined) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  }
  await rm(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
});

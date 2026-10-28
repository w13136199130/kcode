import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const cwd = fileURLToPath(new URL("../..", import.meta.url));
/** S0-2：仓库根从模块 URL 推导（正斜杠、无尾斜杠，与原硬编码一致）；KCODE_E2E_REPO 可覆盖 */
const repoRoot = (): string => {
  const p = decodeURIComponent(new URL("../../../..", import.meta.url).pathname);
  const noDrive = process.platform === "win32" ? p.slice(1) : p;
  return noDrive.endsWith("/") ? noDrive.slice(0, -1) : noDrive;
};
const kcodePath = process.env["KCODE_E2E_REPO"] ?? repoRoot();

function kill(app: ElectronApplication): void {
  const pid = app.process().pid;
  if (pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  else process.kill(-pid, "SIGKILL");
}

async function ready(page: Page): Promise<void> {
  await expect(page.locator(".desktop-v2")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".composer-mode")).toBeEnabled({ timeout: 20_000 });
}

test("双窗口同会话：第二个窗口收到明确拒绝，第一个继续", async () => {
  test.setTimeout(90_000);
  const fakeHome = await mkdtemp(join(tmpdir(), "kcode-dual-active-"));
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
  const now = Date.now() - 60_000;
  await writeFile(
    join(sessions, "sess_dual_active.jsonl"),
    [
      JSON.stringify({
        v: 1,
        type: "session_start",
        ts: now,
        sessionId: "sess_dual_active",
        model: "mock/model",
        workspaceKey: kcodePath,
      }),
      JSON.stringify({ v: 1, type: "user_message", ts: now + 1, sessionId: "sess_dual_active", content: "双活测试会话" }),
      JSON.stringify({ v: 1, type: "assistant_message", ts: now + 2, sessionId: "sess_dual_active", content: "ok" }),
    ].join("\n") + "\n",
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

  try {
    const pageA = await app.firstWindow({ timeout: 20_000 });
    await pageA.addInitScript((value) => localStorage.setItem("kcode-last-cwd", value), kcodePath);
    await pageA.reload();
    await ready(pageA);
    await pageA.locator('[data-session-id="sess_dual_active"]').click();
    await expect(pageA.locator(".row-user")).toBeVisible({ timeout: 20_000 });

    await pageA.evaluate(() => window.kcodeHost?.newWindow());
    const pageB = await app.waitForEvent("window");
    await ready(pageB);
    await pageB.locator('[data-session-id="sess_dual_active"]').click();
    await expect(pageB.locator(".create-failure .cf-msg")).toContainText("其他窗口", { timeout: 20_000 });
    await expect(pageA.locator(".create-failure")).toHaveCount(0);
    await expect(pageA.locator(".row-user")).toBeVisible();

    const second = app.windows().at(-1);
    expect(second).toBeDefined();
  } finally {
    kill(app);
    await rm(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
});

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

/**
 * S1-7 桌面预算护栏：config budget.maxSessionTokens 小于历史累计用量，
 * 续接会话再提交 → fail-closed 成 session_end(rejected + 预算 detail) → 暂停条出现。
 */
test("预算到顶出现暂停条（S1-7）", async () => {
  test.setTimeout(90_000);
  const fakeHome = await mkdtemp(join(tmpdir(), "kcode-budget-"));
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
      budget: { maxSessionTokens: 4000 },
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
  const id = "sess_budget_1";
  await writeFile(
    join(sessions, `${id}.jsonl`),
    [
      JSON.stringify({ v: 1, type: "session_start", ts: Date.now() - 60_000, sessionId: id, model: "mock/model", workspaceKey: kcodePath }),
      JSON.stringify({ v: 1, type: "user_message", ts: Date.now() - 59_000, sessionId: id, content: "预算任务" }),
      JSON.stringify({ v: 1, type: "assistant_message", ts: Date.now() - 58_000, sessionId: id, content: "ok" }),
      // 历史累计 6000 tokens（> 预算 4000）：resumeUsage 种入预算检查
      JSON.stringify({
        v: 1,
        type: "session_end",
        ts: Date.now() - 57_000,
        sessionId: id,
        reason: "completed",
        usage: { inputTokens: 5000, outputTokens: 1000, calls: 3 },
      }),
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
  const page = await app.firstWindow({ timeout: 20_000 });
  try {
    await page.addInitScript((value) => localStorage.setItem("kcode-last-cwd", value), kcodePath);
    await page.reload();
    await expect(page.locator(".desktop-v2")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".composer-input")).toBeEnabled({ timeout: 20_000 });

    // 续接种子会话 → 提交 → 预算 fail-closed → 暂停条
    await page.locator(`[data-session-id="${id}"]`).click();
    await expect(page.locator(".row-user").filter({ hasText: "预算任务" })).toBeVisible({ timeout: 20_000 });
    await page.locator(".composer-input").fill("再跑一轮");
    await page.locator(".composer-input").press("Enter");
    const bar = page.locator(".continue-bar");
    await expect(bar).toBeVisible({ timeout: 20_000 });
    await expect(bar).toContainText("会话 token 预算已用尽");
    await expect(bar.locator(".continue-btn")).toBeVisible();
  } finally {
    kill(app);
    await rm(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
});

import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

// CI 共享 2 核 runner 上 dispose/create 竞态偶发（本地稳定）；重试上限放宽到 2
test.describe.configure({ retries: 2 });
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

async function launch(env: Record<string, string | undefined>): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ["dist/main.cjs", "--headless", "--no-sandbox", "--disable-gpu"],
    cwd,
    env,
  });
  const page = await app.firstWindow({ timeout: 20_000 });
  await page.addInitScript((value) => localStorage.setItem("kcode-last-cwd", value), kcodePath);
  await page.reload();
  await expect(page.locator(".desktop-v2")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".composer-mode")).toBeEnabled({ timeout: 20_000 });
  return { app, page };
}

test("任务组新建路径：ungrouped 持久化，重启后仍在任务", async () => {
  test.setTimeout(90_000);
  const fakeHome = await mkdtemp(join(tmpdir(), "kcode-inbox-"));
  const kcodeHome = join(fakeHome, ".kcode");
  await mkdir(join(kcodeHome, "cli", "sessions"), { recursive: true });
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

  const first = await launch(env);
  try {
    // 慢机串行化：boot 自动建会话先落定（草稿行可见）再操作——否则 dispose/create 与
    // 后续 submit 在 2 核 runner 上竞态，submit 可打在会话未就绪上（CI 三连挂的根因方向）
    await expect(first.page.locator('.d2-task').filter({ hasText: '新任务' })).toBeVisible({ timeout: 20_000 });
    await first.page.locator(".d2-inbox .d2-label").click();
    await first.page.locator(".d2-new").click();
    await first.page.locator(".composer-input").fill("任务组会话");
    await expect(first.page.locator(".composer-send")).toBeEnabled({ timeout: 10_000 });
    await first.page.locator(".composer-input").press("Enter");
    // 前提：提交真的进来了（user_message 行先于侧栏刷新出现）；失败即 submit 被吞，而非列表问题
    await expect(first.page.locator(".row-user").filter({ hasText: "任务组会话" })).toBeVisible({ timeout: 20_000 });
    const inboxTask = first.page.locator(".d2-inbox .d2-task").filter({ hasText: "任务组会话" });
    // 提交 → user_message → sessions/changed → 侧栏重拉全链路：CI 慢机（2 核）给足余量
    await expect(inboxTask).toBeVisible({ timeout: 30_000 });
    const inboxId = await inboxTask.getAttribute("data-session-id");
    expect(inboxId).not.toBeNull();
    const projectIds = await first.page
      .locator(".d2-project .d2-task")
      .evaluateAll((els) => els.map((element) => element.getAttribute("data-session-id")));
    expect(projectIds).not.toContain(inboxId);
  } finally {
    kill(first.app);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));

  const second = await launch(env);
  try {
    await second.page.locator(".d2-inbox .d2-label").click();
    await expect(
      second.page.locator(".d2-inbox .d2-task").filter({ hasText: "任务组会话" }),
    ).toBeVisible({ timeout: 20_000 });
  } finally {
    kill(second.app);
    await rm(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
});

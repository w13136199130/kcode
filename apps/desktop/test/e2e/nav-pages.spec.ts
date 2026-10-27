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

/** S1-8（F20/F21）：自动化/插件市场一级导航静态占位页。 */
test("一级导航占位页可切换并可返回对话（S1-8）", async () => {
  test.setTimeout(90_000);
  const fakeHome = await mkdtemp(join(tmpdir(), "kcode-nav-"));
  const kcodeHome = join(fakeHome, ".kcode");
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
  try {
    await page.addInitScript((value) => localStorage.setItem("kcode-last-cwd", value), kcodePath);
    await page.reload();
    await expect(page.locator(".desktop-v2")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".composer-input")).toBeEnabled({ timeout: 20_000 });

    // 自动化占位页
    await page.locator(".d2-nav").getByRole("button", { name: "自动化" }).click();
    const auto = page.locator('[data-nav-page="automation"]');
    await expect(auto).toBeVisible();
    await expect(auto).toContainText("还没有定时任务");
    await expect(page.locator(".composer-input")).toHaveCount(0);

    // 插件市场占位页
    await page.locator(".d2-nav").getByRole("button", { name: "插件市场" }).click();
    const plugins = page.locator('[data-nav-page="plugins"]');
    await expect(plugins).toBeVisible();
    await expect(plugins).toContainText("本地插件管理优先");

    // 返回对话：主工作区与 Composer 恢复
    await plugins.getByRole("button", { name: "← 返回对话" }).click();
    await expect(page.locator(".composer-input")).toBeEnabled({ timeout: 10_000 });
    await expect(page.locator(".d2-nav").getByRole("button", { name: "对话" })).toHaveClass(/active/);
  } finally {
    kill(app);
    await rm(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
});

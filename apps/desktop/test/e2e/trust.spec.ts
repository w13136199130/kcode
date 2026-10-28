import { test, expect, _electron as electron } from "@playwright/test";
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

test("未信任 banner 可直接信任并消失", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "kcode-trust-banner-"));
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
  const app = await electron.launch({
    args: ["dist/main.cjs", "--headless", "--no-sandbox", "--disable-gpu"],
    cwd,
    env,
  });
  try {
    const page = await app.firstWindow({ timeout: 20_000 });
    await page.addInitScript((value) => localStorage.setItem("kcode-last-cwd", value), kcodePath);
    await page.reload();
    await expect(page.locator(".desktop-v2")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".trust-banner")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".trust-banner .tb-copy")).toContainText("工作区尚未信任");
    await expect(page.locator(".timeline-stack").getByText("项目未被信任")).toHaveCount(0);
    await page.locator(".trust-banner .tb-action").click();
    await expect(page.locator(".trust-banner")).toHaveCount(0, { timeout: 15_000 });
    // 信任持久化（回归一：workspace/status 漏 await 恒返回 falsy）+ 请求 id 跨连接撞号
    // （回归二：host #responses 幂等缓存按 id 全局键控，reload 后新页 desktop-3 撞旧缓存
    // 直接吐旧 false 响应）——页面重载后重查 status，banner 不得再出现。
    await page.reload();
    await expect(page.locator(".desktop-v2")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".trust-banner")).toHaveCount(0, { timeout: 15_000 });
  } finally {
    const pid = app.process().pid;
    if (pid !== undefined) {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      else process.kill(-pid, "SIGKILL");
    }
    await rm(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
});

import { test, expect, _electron as electron } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * D0-09 桌面 E2E（无远端依赖）：
 * - 打包态相对资源加载（回归：base "./" 之前是空白页）
 * - sandbox preload 桥可用、nodeIntegration 仍关闭
 * - host 握手 ready、reload 后 replay 重挂不空白
 * - 关窗后 main 进程退出
 */
test("首启 → host ready → reload replay → preload/CSP → 关闭", async () => {
  test.setTimeout(90_000);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: ["dist/main.cjs", "--headless", "--no-sandbox", "--disable-gpu"],
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env,
  });
  const log = (msg: string): void => process.stdout.write(`[e2e] ${msg}\n`);
  app.process().stdout?.on("data", (data) => log(`main: ${String(data).trim()}`));
  const page = await app.firstWindow({ timeout: 20_000 });
  page.on("console", (msg) => log(`renderer ${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => log(`pageerror: ${err.message}`));
  log("window");

  await expect(page.locator(".workspace-root")).toBeVisible();
  log("root visible");
  await expect(page.locator("body")).not.toContainText("连接宿主中", { timeout: 20_000 });
  log("host ready");
  await expect(page.locator(".workspace-header")).toBeVisible();

  // D0-08：sandbox preload 只暴露 kcodeHost；renderer 仍无 Node require
  expect(await page.evaluate(() => typeof window.kcodeHost)).toBe("object");
  expect(await page.evaluate(() => typeof (window as { require?: unknown }).require)).toBe("undefined");
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute("content");
  expect(csp).toContain("default-src 'self'");

  // reload：main 给新 renderer 重挂 MessageChannel，session/replay 不能把界面变空
  await page.reload();
  log("reloaded");
  await expect(page.locator(".workspace-root")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("连接宿主中", { timeout: 20_000 });
  log("host ready after reload");
  await expect(page.locator(".workspace-header")).toBeVisible();

  const proc = app.process();
  log("closing");
  // Playwright 的 app.close() 在本机 headless Windows 上会等进程树彻底回收而挂住；
  // 关窗本身由 page.close 覆盖，进程收口用 kill 兜底（D0-05 的 host 清理另有单测）。
  await page.close();
  expect(page.isClosed()).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  if (proc.exitCode === null && proc.pid !== undefined) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
    } else {
      proc.kill("SIGKILL");
    }
  }
  log("closed");
});

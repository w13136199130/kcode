import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../..", import.meta.url));
/** S0-2：仓库根从模块 URL 推导（正斜杠、无尾斜杠，与原硬编码一致）；KCODE_E2E_REPO 可覆盖 */
const repoRoot = (): string => {
  const p = decodeURIComponent(new URL("../../../..", import.meta.url).pathname);
  const noDrive = process.platform === "win32" ? p.slice(1) : p;
  return noDrive.endsWith("/") ? noDrive.slice(0, -1) : noDrive;
};
const kcodePath = process.env["KCODE_E2E_REPO"] ?? repoRoot();

/** 建一个假 KCODE_HOME（可指定 provider baseURL）；返回 { root, env }。 */
async function setup(opts?: { baseURL?: string }): Promise<{ root: string; env: Record<string, string | undefined> }> {
  const root = await mkdtemp(join(tmpdir(), "kcode-create-fail-"));
  const home = join(root, ".kcode");
  await mkdir(join(home, "cli", "sessions"), { recursive: true });
  await mkdir(join(home, "desktop"), { recursive: true });
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      models: {
        default: "mock/model",
        providers: { mock: { type: "openai-compatible", baseURL: opts?.baseURL ?? "https://example.com/v1" } },
      },
    }),
    "utf8",
  );
  await writeFile(
    join(home, "desktop", "projects.json"),
    JSON.stringify({
      version: 1,
      workspaces: [{ path: kcodePath, name: "kcode", createdAt: Date.now(), updatedAt: Date.now() }],
    }),
    "utf8",
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    KCODE_HOME: home,
    KCODE_DESKTOP_USER_DATA: join(root, "userData"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return { root, env };
}

/** 与其他 spec 一致：树杀 Electron/host（app.close() 在本机会等待优雅退出而挂死）。 */
function kill(app: ElectronApplication): void {
  const pid = app.process().pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  } else {
    process.kill(-pid, "SIGKILL");
  }
}

async function cleanup(app: ElectronApplication, root: string): Promise<void> {
  kill(app);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
}

async function launch(env: Record<string, string | undefined>) {
  const app = await electron.launch({
    args: ["dist/main.cjs", "--headless", "--no-sandbox", "--disable-gpu"],
    cwd,
    env,
  });
  const page = await app.firstWindow({ timeout: 20_000 });
  await page.addInitScript((value) => localStorage.setItem("kcode-last-cwd", value), kcodePath);
  await page.reload();
  await expect(page.locator(".desktop-v2")).toBeVisible({ timeout: 20_000 });
  return { app, page };
}

test("新建会话失败可见且重试可恢复（P0-2，M3）", async () => {
  test.setTimeout(90_000);
  test.slow(); // 慢速 CI runner 上启动链与故障注入有固有竞态：放大等待窗口（本地 10/10 稳定）
  const { root, env } = await setup();
  // 首次（启动自动）创建放行；第 2 次创建（用户点新建）注入失败；第 3 次（重试）恢复
  env.KCODE_FAULT_STAGE = "create-reject";
  env.KCODE_FAULT_AFTER_CREATES = "1";
  const { app, page } = await launch(env);

  try {
    // 启动自动创建成功 → composer 可发送
    await expect(page.locator(".composer-mode")).toBeEnabled({ timeout: 20_000 });

    // 用户新建 → 注入失败 → 失败卡片可见（不再静默死掉 composer）
    await page.locator(".d2-new").click();
    await expect(page.locator(".create-failure")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".create-failure .cf-msg")).toContainText("注入失败", { timeout: 15_000 });

    // 重试（复用同一 requestId）→ 创建成功 → 卡片消失、composer 恢复
    const retryBtn = page.locator(".create-failure .cf-btn", { hasText: "重试" });
    await expect(retryBtn).toBeVisible({ timeout: 15_000 });
    await retryBtn.click({ timeout: 15_000 });
    await expect(page.locator(".create-failure")).toBeHidden({ timeout: 10_000 });
    await expect(page.locator(".composer-mode")).toBeEnabled({ timeout: 10_000 });
  } finally {
    await cleanup(app, root);
  }
});

test("运行中新建被拦截并提示，任务继续运行（P0-3）", async () => {
  test.setTimeout(90_000);
  // 本地“接受连接但永不响应”的服务器：llm 请求确定性挂起 → busy 保持 true
  const stall = net.createServer((socket) => {
    socket.on("error", () => undefined); // app 被杀时收到 RST 属预期，不冒泡成测试错误
    socket.resume();
  });
  stall.on("error", () => undefined);
  await new Promise<void>((resolve) => stall.listen(0, "127.0.0.1", resolve));
  const port = (stall.address() as net.AddressInfo).port;
  const { root, env } = await setup({ baseURL: `http://127.0.0.1:${port}/v1` });
  const { app, page } = await launch(env);

  try {
    // 先填文本：send 可用＝会话就绪（空输入时 send 本就 disabled；input enabled 只代表连接就绪）
    await page.locator(".composer-input").fill("跑一个会挂起的任务");
    await expect(page.locator(".composer-send")).toBeEnabled({ timeout: 20_000 });
    await page.locator(".composer-input").press("Enter");
    await expect(page.locator(".composer-stop")).toBeVisible({ timeout: 10_000 });

    // 运行中点新建 → 被拦截：出现提示行，且没有 dispose（无失败卡片、停止按钮仍在）
    await page.locator(".d2-new").click();
    await expect(page.locator(".row-info").filter({ hasText: "运行中不能新建会话" })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".create-failure")).toHaveCount(0);
    await expect(page.locator(".composer-stop")).toBeVisible();
  } finally {
    await cleanup(app, root);
    stall.closeAllConnections?.();
    stall.close();
  }
});

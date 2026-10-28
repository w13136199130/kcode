import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function setup(): Promise<{ home: string; env: Record<string, string | undefined> }> {
  const root = await mkdtemp(join(tmpdir(), "kcode-create-fault-"));
  const home = join(root, ".kcode");
  await mkdir(join(home, "cli", "sessions"), { recursive: true });
  await mkdir(join(home, "desktop"), { recursive: true });
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      models: {
        default: "mock/model",
        providers: { mock: { type: "openai-compatible", baseURL: "https://example.com/v1" } },
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
    KCODE_FAULT_AFTER_CREATES: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return { home, env };
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
  await expect(page.locator(".composer-mode")).toBeEnabled({ timeout: 20_000 });
  return { app, page };
}

function kill(app: import("@playwright/test").ElectronApplication): void {
  const pid = app.process().pid;
  if (pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  else process.kill(-pid, "SIGKILL");
}

for (const stage of ["after-draft", "after-create"]) {
  test(`新建会话在 ${stage} 阶段中断后可恢复`, async () => {
    test.setTimeout(90_000);
    const { home, env } = await setup();
    env["KCODE_FAULT_STAGE"] = stage;
    const first = await launch(env);
    await first.page.locator(".d2-new").click();

    await expect
      .poll(
        async () => {
          try {
            const raw = await readFile(join(home, "desktop", "session-index.json"), "utf8");
            const parsed = JSON.parse(raw) as { sessions?: Array<{ status?: string }> };
            return (parsed.sessions ?? []).filter((s) => s.status === "draft").length;
          } catch {
            return 0;
          }
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    kill(first.app);

    delete env["KCODE_FAULT_STAGE"];
    const second = await launch(env);
    await expect(second.page.locator(".d2-task").filter({ hasText: "新任务" }).first()).toBeVisible();
    kill(second.app);
    await rm(join(home, ".."), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });
}

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

test("host 被强制终止后，回收站状态仍可恢复", async () => {
  test.setTimeout(90_000);
  const fakeHome = await mkdtemp(join(tmpdir(), "kcode-desktop-crash-"));
  const kcodeHome = join(fakeHome, ".kcode");
  const sessions = join(kcodeHome, "cli", "sessions");
  await mkdir(sessions, { recursive: true });
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
  await mkdir(join(kcodeHome, "desktop"), { recursive: true });
  await writeFile(
    join(kcodeHome, "desktop", "projects.json"),
    JSON.stringify({
      version: 1,
      workspaces: [{ path: kcodePath, name: "kcode", createdAt: Date.now(), updatedAt: Date.now() }],
    }),
    "utf8",
  );
  const now = Date.now() - 60_000;
  const writeSession = async (id: string, title: string): Promise<void> => {
    await writeFile(
      join(sessions, `${id}.jsonl`),
      [
        JSON.stringify({ v: 1, type: "session_start", ts: now, sessionId: id, model: "mock/model", workspaceKey: kcodePath }),
        JSON.stringify({ v: 1, type: "user_message", ts: now + 1, sessionId: id, content: title }),
        JSON.stringify({ v: 1, type: "assistant_message", ts: now + 2, sessionId: id, content: "ok" }),
      ].join("\n") + "\n",
      "utf8",
    );
  };
  await writeSession("sess_crash_seed", "启动前的会话");
  await writeSession("sess_crash_deleted", "崩溃前删除的会话");
  await writeFile(
    join(kcodeHome, "desktop", "session-trash.json"),
    JSON.stringify({ version: 1, deleted: { sess_crash_deleted: Date.now() } }),
    "utf8",
  );
  // 模拟“索引已写、HostSession/JSONL 还没落盘”时被 kill 的 draft。
  await writeFile(
    join(kcodeHome, "desktop", "session-index.json"),
    JSON.stringify({
      version: 1,
      sessions: [
        {
          sessionId: "sess_crash_draft",
          workspaceKey: "E:/space/crash-draft",
          createdAt: now,
          updatedAt: now,
          status: "draft",
        },
      ],
    }),
    "utf8",
  );

  const env = {
    ...process.env,
    KCODE_HOME: kcodeHome,
    KCODE_DESKTOP_USER_DATA: join(fakeHome, "userData"),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const launch = async () => {
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
    return { app, page };
  };

  const first = await launch();
  await expect(first.page.locator(".d2-trash")).toBeVisible();
  await expect(first.page.locator(".d2-project-row").filter({ hasText: "crash-draft" })).toBeVisible();
  await expect(first.page.locator(".d2-task").filter({ hasText: "新任务" })).toBeVisible();
  const pid = first.app.process().pid;
  if (pid !== undefined) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  }
  await new Promise((resolve) => setTimeout(resolve, 800));

  const second = await launch();
  await expect(second.page.locator(".d2-trash")).toBeVisible({ timeout: 10_000 });
  await second.page.locator(".d2-trash .d2-label").click();
  const trashed = second.page.locator(".d2-trash .d2-task").filter({ hasText: "崩溃前删除的会话" });
  await expect(trashed).toBeVisible();
  await trashed.hover();
  await trashed.locator(".d2-task-more").click();
  await second.page.locator(".d2-task-menu button").filter({ hasText: "恢复任务" }).click();
  await expect(second.page.locator(".d2-trash")).toHaveCount(0);
  await expect(second.page.locator(".d2-task").filter({ hasText: "崩溃前删除的会话" })).toBeVisible();

  const secondPid = second.app.process().pid;
  if (secondPid !== undefined) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(secondPid), "/T", "/F"], { windowsHide: true });
    else process.kill(-secondPid, "SIGKILL");
  }
  await rm(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
});

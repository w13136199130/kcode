import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
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
  await expect(page.locator(".composer-input")).toBeEnabled({ timeout: 20_000 });
  return { app, page };
}

/**
 * S1-1 菜单补齐（F4/F5）：任务 导出/复制 ID；工作区 在编辑器中打开/归档。
 * 编辑器经 KCODE_EDITOR=node（CI/本地皆有）；导出目录经主进程 dialog 打桩。
 */
test("任务与工作区菜单四动作（S1-1）", async () => {
  test.setTimeout(120_000);
  const fakeHome = await mkdtemp(join(tmpdir(), "kcode-menus-"));
  const exportDir = join(fakeHome, "exports");
  const kcodeHome = join(fakeHome, ".kcode");
  const sessions = join(kcodeHome, "cli", "sessions");
  await mkdir(sessions, { recursive: true });
  await mkdir(exportDir, { recursive: true });
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
      workspaces: [
        { path: kcodePath, name: "kcode", createdAt: Date.now() - 5_000, updatedAt: Date.now() - 5_000 },
        { path: `${kcodePath}/apps/web`, name: "web", createdAt: Date.now(), updatedAt: Date.now() },
      ],
    }),
    "utf8",
  );
  const id = "sess_menus_1";
  await writeFile(
    join(sessions, `${id}.jsonl`),
    [
      JSON.stringify({ v: 1, type: "session_start", ts: Date.now() - 60_000, sessionId: id, model: "mock/model", workspaceKey: kcodePath }),
      JSON.stringify({ v: 1, type: "user_message", ts: Date.now() - 59_000, sessionId: id, content: "菜单验证任务" }),
      JSON.stringify({ v: 1, type: "assistant_message", ts: Date.now() - 58_000, sessionId: id, content: "ok" }),
    ].join("\n") + "\n",
    "utf8",
  );
  const env = {
    ...process.env,
    KCODE_HOME: kcodeHome,
    KCODE_DESKTOP_USER_DATA: join(fakeHome, "userData"),
    KCODE_EDITOR: "node",
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const { app, page } = await launch(env);
  const alerts: string[] = [];
  page.on("dialog", (dialog) => {
    alerts.push(dialog.message());
    void dialog.accept();
  });
  try {
    // 导出目录选择打桩：主进程 dialog.showOpenDialog 固定返回 exports 目录
    await app.evaluate(({ dialog }, arg: { dir: string }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [arg.dir] });
    }, { dir: exportDir });

    const task = page.locator(`[data-session-id="${id}"]`);
    await expect(task).toBeVisible({ timeout: 20_000 });
    await task.hover();
    await task.locator(".d2-task-more").click();
    const taskMenu = page.locator(".d2-task-menu");
    await expect(taskMenu).toBeVisible();

    // ① 复制 ID → 系统剪贴板
    await taskMenu.getByRole("button", { name: "复制 ID" }).click();
    await expect(page.locator(".d2-notice")).toContainText("已复制会话 ID", { timeout: 5_000 });
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(clip).toBe(id);

    // ② 导出 JSONL → host 落盘到打桩目录
    await task.hover();
    await task.locator(".d2-task-more").click();
    await page.locator(".d2-task-menu").getByRole("button", { name: "导出 JSONL" }).click();
    await expect
      .poll(() => alerts.some((message) => message.startsWith("已导出")), { timeout: 10_000 })
      .toBe(true);
    const exported = await readFile(join(exportDir, `${id}.jsonl`), "utf8");
    expect(exported).toContain("菜单验证任务");

    // ③ 在编辑器中打开（KCODE_EDITOR=node）→ notice
    const web = page.locator(".d2-project").filter({ hasText: "web" }).first();
    await web.hover();
    await web.locator('button[title="工作区操作"]').click();
    await page.locator(".d2-project-menu").getByRole("button", { name: "在编辑器中打开" }).click();
    await expect(page.locator(".d2-notice")).toContainText("已用 node 打开", { timeout: 5_000 });

    // ④ 归档工作区 → 主列表消失、进入已归档分区；取消归档 → 回到主列表
    await web.hover();
    await web.locator('button[title="工作区操作"]').click();
    await page.locator(".d2-project-menu").getByRole("button", { name: "归档工作区" }).click();
    await expect(page.locator(".d2-notice")).toContainText("已归档", { timeout: 5_000 });
    await expect(page.locator(".d2-workspaces .d2-project").filter({ hasText: "web" })).toHaveCount(0);
    const archivedSection = page.locator(".d2-archived-workspaces");
    await expect(archivedSection).toBeVisible();
    await archivedSection.locator(".d2-label").click();
    await expect(archivedSection.locator(".d2-archived-workspace")).toContainText("web");
    await archivedSection.getByRole("button", { name: "取消归档" }).click();
    await expect(page.locator(".d2-workspaces .d2-project").filter({ hasText: "web" })).toHaveCount(1);
    await expect(archivedSection).toHaveCount(0);
  } finally {
    kill(app);
    await rm(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
});

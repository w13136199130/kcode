import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function jsonl(events: Array<Record<string, unknown>>): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

async function seedSession(
  dir: string,
  id: string,
  workspaceKey: string,
  preview: string,
  ageMs: number,
): Promise<void> {
  const file = join(dir, `${id}.jsonl`);
  const now = Date.now() - ageMs;
  await writeFile(
    file,
    jsonl([
      { v: 1, type: "session_start", ts: now, sessionId: id, model: "mock/model", workspaceKey },
      { v: 1, type: "user_message", ts: now + 1, sessionId: id, content: preview },
      { v: 1, type: "assistant_message", ts: now + 2, sessionId: id, content: "ok" },
      { v: 1, type: "session_end", ts: now + 3, sessionId: id, reason: "completed" },
    ]),
    "utf8",
  );
  await utimes(file, new Date(now), new Date(now));
}

async function seedEmptySession(dir: string, id: string, workspaceKey: string): Promise<void> {
  const file = join(dir, `${id}.jsonl`);
  const now = Date.now() - 20 * 60 * 60_000;
  await writeFile(
    file,
    jsonl([
      { v: 1, type: "session_start", ts: now, sessionId: id, model: "mock/model", workspaceKey },
      { v: 1, type: "session_end", ts: now + 1, sessionId: id, reason: "completed" },
    ]),
    "utf8",
  );
  await utimes(file, new Date(now), new Date(now));
}

test("desktop v2 sidebar", async () => {
  test.setTimeout(90_000);
  const fakeHome = await mkdtemp(join(tmpdir(), "kcode-desktop-v2-home-"));
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
  const kcodePath = "E:/space/my_space/MyProject/kcode";
  await mkdir(join(kcodeHome, "desktop"), { recursive: true });
  await writeFile(
    join(kcodeHome, "desktop", "projects.json"),
    JSON.stringify({
      version: 1,
      workspaces: [{ path: kcodePath, name: "kcode", createdAt: Date.now(), updatedAt: Date.now() }],
    }),
    "utf8",
  );
  await seedSession(sessions, "sess_v2_kcode_1", kcodePath, "对比 apps 下 5 个应用", 2 * 60_000);
  await seedSession(sessions, "sess_v2_kcode_2", kcodePath, "修复桌面宿主启动", 60 * 60_000);
  await seedSession(sessions, "sess_v2_kcode_3", kcodePath, "整理 CLI 优化计划", 26 * 60 * 60_000);
  await seedSession(sessions, "sess_v2_web_1", `${kcodePath}/apps/web`, "优化浏览器登录页", 24 * 60 * 60_000);
  await seedSession(sessions, "sess_v2_web_2", `${kcodePath}/apps/web`, "检查 web 构建产物", 2 * 24 * 60 * 60_000);
  await seedSession(sessions, "sess_v2_inbox_1", "", "Nginx TCP 转发与内网 Ntrip Caster 中转方案", 11 * 24 * 60 * 60_000);
  await seedSession(sessions, "sess_v2_inbox_2", "", "分析降雨量与水情指标计算逻辑", 36 * 24 * 60 * 60_000);
  await seedSession(sessions, "sess_v2_root_1", "/", "根目录任务", 3 * 24 * 60 * 60_000);
  await seedEmptySession(sessions, "sess_v2_empty_1", kcodePath);

  const env = {
    ...process.env,
    KCODE_HOME: kcodeHome,
    KCODE_DESKTOP_USER_DATA: join(fakeHome, "userData"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: ["dist/main.cjs", "--headless", "--no-sandbox", "--disable-gpu"],
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env,
  });
  const page = await app.firstWindow({ timeout: 20_000 });
  await page.addInitScript((cwd) => localStorage.setItem("kcode-last-cwd", cwd), "E:\\space\\my_space\\MyProject\\kcode");
  await page.reload();
  await expect(page.locator(".desktop-v2")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".composer-input")).toBeEnabled({ timeout: 20_000 });
  await expect(page.locator(".composer-v2")).toBeVisible();
  await expect(page.locator(".workspace-header-v2")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".empty-v2")).toBeVisible();
  await expect(page.locator(".d2-task").filter({ hasText: "新任务" })).toBeVisible();
  const orderBefore = await page.locator(".d2-project-name").allTextContents();
  await page.locator(".empty-prompt").first().click();
  await expect(page.locator(".composer-input")).toHaveValue(/请先阅读这个仓库/);
  await page.locator(".composer-input").fill("");
  await page.locator(".d2-task").filter({ hasText: "对比 apps 下 5 个应用" }).click();
  await expect(page.locator(".row-user")).toBeVisible({ timeout: 20_000 });
  expect(await page.locator(".d2-project-name").allTextContents()).toEqual(orderBefore);
  await page.waitForTimeout(250);
  await page.locator(".wh-action").filter({ hasText: "变更" }).click();
  await expect(page.locator(".side-pane-v2")).toBeVisible();
  await page.locator(".side-pane-close").click();
  await expect(page.locator(".d2-project").filter({ hasText: "kcode" }).first()).toBeVisible();
  const kcode = page.locator(".d2-project").filter({ hasText: "kcode" }).first();
  await expect(kcode.locator(".d2-task")).toHaveCount(3);
  await expect(page.locator(".d2-project-row").filter({ hasText: "/" })).toHaveCount(0);
  await expect(page.locator(".d2-task").filter({ hasText: "（空会话）" })).toHaveCount(0);

  // 归档：从工作区消失，进入“已归档”，可取消归档。
  const repair = page.locator(".d2-task").filter({ hasText: "修复桌面宿主启动" });
  await repair.hover();
  await repair.locator(".d2-task-more").click();
  await page.locator(".d2-task-menu button").filter({ hasText: "归档任务" }).click();
  await expect(kcode.locator(".d2-task").filter({ hasText: "修复桌面宿主启动" })).toHaveCount(0);
  await expect(page.locator(".d2-archived")).toBeVisible();
  await page.locator(".d2-archived .d2-label").click();
  const archivedRepair = page.locator(".d2-archived .d2-task").filter({ hasText: "修复桌面宿主启动" });
  await expect(archivedRepair).toBeVisible();
  await archivedRepair.hover();
  await archivedRepair.locator(".d2-task-more").click();
  await page.locator(".d2-task-menu button").filter({ hasText: "取消归档" }).click();
  await expect(page.locator(".d2-archived")).toHaveCount(0);
  await expect(kcode.locator(".d2-task").filter({ hasText: "修复桌面宿主启动" })).toBeVisible();

  // 软删除 → 回收站 → 恢复。
  page.once("dialog", (dialog) => void dialog.accept());
  const cleanupTask = page.locator(".d2-task").filter({ hasText: "整理 CLI 优化计划" });
  await cleanupTask.hover();
  await cleanupTask.locator(".d2-task-more").click();
  await page.locator(".d2-task-menu button").filter({ hasText: "删除任务" }).click();
  await expect(page.locator(".d2-trash")).toBeVisible();
  await expect(cleanupTask).toHaveCount(0);
  await page.locator(".d2-trash .d2-label").click();
  const trashTask = page.locator(".d2-trash .d2-task").filter({ hasText: "整理 CLI 优化计划" });
  await expect(trashTask).toBeVisible();
  await trashTask.hover();
  await trashTask.locator(".d2-task-more").click();
  await page.locator(".d2-task-menu button").filter({ hasText: "恢复任务" }).click();
  await expect(page.locator(".d2-trash")).toHaveCount(0);
  await expect(page.locator(".d2-task").filter({ hasText: "整理 CLI 优化计划" })).toBeVisible();

  await kcode.locator(".d2-project-actions button[title='工作区操作']").click();
  await expect(page.locator(".d2-project-menu").filter({ hasText: "信任工作区" })).toBeVisible();
  await page.locator(".d2-project-menu button").filter({ hasText: "信任工作区" }).click();
  await expect(page.locator(".d2-notice")).toContainText("已信任工作区");
  await page.locator(".d2-project-row").filter({ hasText: "web" }).click();
  await expect(page.locator(".d2-project-row").filter({ hasText: "web" })).toHaveClass(/active/);
  // 各工作区展开状态独立：打开 web 不应折叠 kcode。
  await expect(kcode.locator(".d2-task")).toHaveCount(3);
  await expect(page.locator(".d2-task").filter({ hasText: "优化浏览器登录页" })).toBeVisible();
  await page.locator(".d2-project-row").filter({ hasText: "web" }).click();
  await expect(page.locator(".d2-task").filter({ hasText: "优化浏览器登录页" })).toBeHidden();
  await expect(kcode.locator(".d2-task")).toHaveCount(3);

  // 工作区标题整体折叠/展开；展开后保留各工作区自己的展开状态。
  await page.locator(".d2-label").first().click();
  await expect(page.locator(".d2-project-row")).toHaveCount(0);
  await page.locator(".d2-label").first().click();
  await expect(page.locator(".d2-project-row")).toHaveCount(2);
  await expect(page.locator(".d2-workspaces .d2-task")).toHaveCount(3);

  // 任务组独立折叠；默认折叠。
  await expect(page.locator(".d2-inbox .d2-tasks")).toBeHidden();
  await page.locator(".d2-inbox .d2-label").click();
  await expect(page.locator(".d2-inbox .d2-tasks")).toBeVisible();
  await page.locator(".d2-inbox .d2-label").click();
  await expect(page.locator(".d2-inbox .d2-tasks")).toBeHidden();

  // 任务菜单 → 重命名走现有 sessions/rename。
  await page.locator(".d2-task").filter({ hasText: "修复桌面宿主启动" }).hover();
  await page.locator(".d2-task").filter({ hasText: "修复桌面宿主启动" }).locator(".d2-task-more").click();
  await page.locator(".d2-task-menu button").filter({ hasText: "重命名" }).click();
  await page.locator(".d2-rename").fill("重命名后的任务");
  await page.locator(".d2-rename").press("Enter");
  await expect(page.locator(".d2-task").filter({ hasText: "重命名后的任务" })).toBeVisible();

  await page.locator(".d2-icon[title='搜索工作区或任务']").click();
  await expect(page.locator(".d2-search input")).toBeVisible();
  await page.locator(".d2-search input").fill("降雨量");
  await expect(page.locator(".d2-task").filter({ hasText: "分析降雨量" })).toBeVisible();
  await expect(page.locator(".d2-project-row").filter({ hasText: "web" })).toHaveCount(0);
  await page.locator(".d2-search input").fill("");

  // 新建 → 发送 → 再新建：前一任务必须仍在分组里。
  await page.locator(".d2-new").click();
  await page.locator(".composer-input").fill("你好");
  await expect(page.locator(".composer-send")).toBeEnabled({ timeout: 10_000 });
  await page.locator(".composer-input").press("Enter");
  await expect(page.locator(".d2-task").filter({ hasText: "你好" })).toBeVisible({ timeout: 10_000 });
  // P0-3 护栏：运行中新建会被拦截——等本轮结束再新建。
  // 注意 .composer-send 忙碌时也渲染（title 变“排队”），空闲信号是 stop 消失。
  await expect(page.locator(".composer-stop")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".d2-new").click();
  await expect(page.locator(".d2-task").filter({ hasText: "你好" })).toBeVisible();
  await expect(page.locator(".d2-task").filter({ hasText: "新任务" })).toBeVisible();

  await page.locator(".d2-settings").click();
  await expect(page.locator(".settings-v2")).toBeVisible();
  await expect(page.locator(".sv-head h2")).toHaveText("模型设置");
  await page.locator(".sv-close").click();

  // 旧侧栏回退：localStorage 开关。
  await page.evaluate(() => localStorage.setItem("kcode-desktop-ui-v2", "classic"));
  await page.reload();
  await expect(page.locator(".desktop-v2")).toHaveCount(0);
  await expect(page.locator(".sidebar-head")).toBeVisible();

  const proc = app.process();
  await page.close();
  if (proc.exitCode === null && proc.pid !== undefined) {
    if (process.platform === "win32") {
      const { spawnSync } = await import("node:child_process");
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
    } else {
      proc.kill("SIGKILL");
    }
  }
  await rm(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
});

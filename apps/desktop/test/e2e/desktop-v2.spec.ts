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
  await seedSession(sessions, "sess_v2_kcode_1", kcodePath, "对比 apps 下 5 个应用", 2 * 60_000);
  await seedSession(sessions, "sess_v2_kcode_2", kcodePath, "修复桌面宿主启动", 60 * 60_000);
  await seedSession(sessions, "sess_v2_kcode_3", kcodePath, "整理 CLI 优化计划", 26 * 60 * 60_000);
  await seedSession(sessions, "sess_v2_web_1", `${kcodePath}/apps/web`, "优化浏览器登录页", 24 * 60 * 60_000);
  await seedSession(sessions, "sess_v2_web_2", `${kcodePath}/apps/web`, "检查 web 构建产物", 2 * 24 * 60 * 60_000);
  await seedSession(sessions, "sess_v2_inbox_1", "", "Nginx TCP 转发与内网 Ntrip Caster 中转方案", 11 * 24 * 60 * 60_000);
  await seedSession(sessions, "sess_v2_inbox_2", "", "分析降雨量与水情指标计算逻辑", 36 * 24 * 60 * 60_000);

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
  await expect(page.locator(".d2-project").filter({ hasText: "kcode" }).first()).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);

  const kcode = page.locator(".d2-project").filter({ hasText: "kcode" }).first();
  await expect(kcode.locator(".d2-task")).toHaveCount(3);
  await page.locator(".d2-project-row").filter({ hasText: "web" }).click();
  await expect(page.locator(".d2-project-row").filter({ hasText: "web" })).toHaveClass(/active/);
  await expect(kcode.locator(".d2-task")).toHaveCount(0);
  await expect(page.locator(".d2-task").filter({ hasText: "优化浏览器登录页" })).toBeVisible();
  await page.locator(".d2-project-row").filter({ hasText: "web" }).click();
  await expect(page.locator(".d2-task").filter({ hasText: "优化浏览器登录页" })).toBeHidden();

  // 工作区标题整体折叠/展开；展开后只出现分组行，不自动展开任何会话。
  await page.locator(".d2-label").first().click();
  await expect(page.locator(".d2-project-row")).toHaveCount(0);
  await page.locator(".d2-label").first().click();
  await expect(page.locator(".d2-project-row")).toHaveCount(2);
  await expect(page.locator(".d2-tasks .d2-task")).toHaveCount(0);
  await kcode.locator(".d2-project-row").click();
  await expect(kcode.locator(".d2-task")).toHaveCount(3);

  // 任务组独立折叠。
  await page.locator(".d2-inbox .d2-label").click();
  await expect(page.locator(".d2-inbox-list")).toBeHidden();
  await page.locator(".d2-inbox .d2-label").click();
  await expect(page.locator(".d2-inbox-list")).toBeVisible();

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

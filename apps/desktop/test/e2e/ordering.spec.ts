import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
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

test("点击旧会话不会把它顶到前面或改成刚刚", async () => {
  test.setTimeout(60_000);
  const fakeHome = await mkdtemp(join(tmpdir(), "kcode-order-"));
  const kcodeHome = join(fakeHome, ".kcode");
  const sessions = join(kcodeHome, "cli", "sessions");
  await mkdir(sessions, { recursive: true });
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
  const writeSession = async (id: string, title: string, ageMs: number): Promise<void> => {
    const ts = Date.now() - ageMs;
    const file = join(sessions, `${id}.jsonl`);
    await writeFile(
      file,
      [
        JSON.stringify({ v: 1, type: "session_start", ts, sessionId: id, model: "mock/model", workspaceKey: kcodePath }),
        JSON.stringify({ v: 1, type: "user_message", ts: ts + 1, sessionId: id, content: title }),
        JSON.stringify({ v: 1, type: "assistant_message", ts: ts + 2, sessionId: id, content: "ok" }),
      ].join("\n") + "\n",
      "utf8",
    );
    await utimes(file, new Date(ts), new Date(ts));
  };
  await writeSession("sess_order_new", "新会话", 60 * 60_000);
  await writeSession("sess_order_old", "旧会话", 3 * 24 * 60 * 60_000);
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
    await expect(page.locator(".composer-input")).toBeEnabled({ timeout: 20_000 });
    const kcode = page.locator(".d2-project").filter({ hasText: "kcode" }).first();
    const before = (await kcode.locator(".d2-task-title").allTextContents()).filter((title) => title !== "新任务");
    expect(before).toEqual(["新会话", "旧会话"]);
    await kcode.locator('[data-session-id="sess_order_old"]').click();
    await expect(page.locator(".row-user")).toBeVisible({ timeout: 20_000 });
    const ids = await kcode
      .locator(".d2-task")
      .evaluateAll((els) =>
        els
          .map((element) => element.getAttribute("data-session-id"))
          .filter((id): id is string => id?.startsWith("sess_order_") === true),
      );
    expect(ids).toEqual(["sess_order_new", "sess_order_old"]);
  } finally {
    const pid = app.process().pid;
    if (pid !== undefined) {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      else process.kill(-pid, "SIGKILL");
    }
    await rm(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
});

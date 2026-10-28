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

test("搜索覆盖前 200 条之外的历史会话", async () => {
  test.setTimeout(90_000);
  const fakeHome = await mkdtemp(join(tmpdir(), "kcode-search-"));
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
  const writes: Promise<void>[] = [];
  for (let i = 0; i < 205; i++) {
    const id = `sess_search_${String(i).padStart(3, "0")}`;
    const ts = Date.now() - (205 - i) * 60_000;
    const content = i === 0 ? "深层历史会话" : `普通会话 ${i}`;
    writes.push(
      writeFile(
        join(sessions, `${id}.jsonl`),
        [
          JSON.stringify({ v: 1, type: "session_start", ts, sessionId: id, model: "mock/model", workspaceKey: kcodePath }),
          JSON.stringify({ v: 1, type: "user_message", ts: ts + 1, sessionId: id, content }),
        ].join("\n") + "\n",
        "utf8",
      ),
    );
  }
  await Promise.all(writes);
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
    await expect(page.locator(".composer-mode")).toBeEnabled({ timeout: 20_000 });
    await page.locator(".d2-icon[title='搜索工作区或任务']").click();
    await page.locator(".d2-search input").fill("深层历史");
    await expect(page.locator(".d2-task").filter({ hasText: "深层历史会话" })).toBeVisible({ timeout: 10_000 });
  } finally {
    const pid = app.process().pid;
    if (pid !== undefined) {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      else process.kill(-pid, "SIGKILL");
    }
    await rm(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
});

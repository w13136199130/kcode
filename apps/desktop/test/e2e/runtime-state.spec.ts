import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
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
 * P4-2（F16）运行态补齐：种子一个包含额度错误 + 步数暂停 + todo/子代理事件的会话，
 * 切换进去经 replay 重建后断言三件套：额度 banner、暂停「继续」条、右上浮动进度卡。
 */
test("运行态三件套：额度 banner / 暂停继续 / 浮动进度卡", async () => {
  test.setTimeout(90_000);
  const fakeHome = await mkdtemp(join(tmpdir(), "kcode-rt-"));
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
    "utf-8",
  );
  const id = "sess_runtime_state";
  await writeFile(
    join(sessions, `${id}.jsonl`),
    [
      JSON.stringify({ v: 1, type: "session_start", ts: Date.now() - 60_000, sessionId: id, model: "mock/model", workspaceKey: kcodePath }),
      JSON.stringify({ v: 1, type: "user_message", ts: Date.now() - 59_000, sessionId: id, content: "跑运行态验证" }),
      JSON.stringify({
        v: 1,
        type: "todo_update",
        ts: Date.now() - 58_000,
        sessionId: id,
        todos: [
          { content: "步骤一", status: "completed", priority: "medium" },
          { content: "步骤二", status: "completed", priority: "medium" },
          { content: "步骤三", status: "pending", priority: "medium" },
          { content: "步骤四", status: "pending", priority: "medium" },
          { content: "步骤五", status: "pending", priority: "medium" },
        ],
      }),
      JSON.stringify({ v: 1, type: "subagent_spawned", ts: Date.now() - 57_000, sessionId: id, agentId: "ag1", agentType: "Explore", description: "搜索运行态文档", childSessionId: "sub_rt1", background: false }),
      JSON.stringify({ v: 1, type: "assistant_message", ts: Date.now() - 56_000, sessionId: id, content: "进行到一半" }),
      JSON.stringify({ v: 1, type: "llm_error", ts: Date.now() - 55_000, sessionId: id, error: "Error code 1112 - 余额不足，请充值后重试" }),
      JSON.stringify({ v: 1, type: "run_limit_reached", ts: Date.now() - 54_000, sessionId: id, maxTurns: 24 }),
      JSON.stringify({ v: 1, type: "session_end", ts: Date.now() - 53_000, sessionId: id, reason: "limit_reached", usage: { inputTokens: 10, outputTokens: 10, calls: 2 } }),
    ].join("\n") + "\n",
    "utf-8",
  );
  const env = {
    ...process.env,
    KCODE_HOME: kcodeHome,
    KCODE_DESKTOP_USER_DATA: join(fakeHome, "userData"),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const { app, page } = await launch(env);
  try {
    // 切入种子会话 → replay 重建运行态
    await page.locator(`[data-session-id="${id}"]`).click();
    await expect(page.locator(".row-user").filter({ hasText: "跑运行态验证" })).toBeVisible({ timeout: 20_000 });

    // ① 额度 banner：文案 + 两个动作按钮
    const banner = page.locator(".row-quota");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("余额不足");
    await expect(banner.locator(".quota-reset")).toHaveText("重置额度");
    await expect(banner.locator(".quota-feedback")).toHaveText("反馈");

    // 反馈：点击后按钮变为「已复制错误信息」
    await banner.locator(".quota-feedback").click();
    await expect(banner.locator(".quota-feedback")).toHaveText("已复制错误信息", { timeout: 5_000 });

    // 重置额度：mock 厂商无映射 → 回落打开设置页
    await banner.locator(".quota-reset").click();
    await expect(page.locator(".settings-v2")).toBeVisible({ timeout: 10_000 });
    await page.locator(".sv-back").click();
    await expect(page.locator(".settings-v2")).toBeHidden();

    // ② 右上浮动进度卡：2/5 + 子智能体卡（运行中 → 空闲也显示）
    const card = page.locator(".runtime-progress-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("2/5");
    await expect(card).toContainText("步骤三");
    await expect(card).toContainText("Explore");
    await expect(card).toContainText("搜索运行态文档");
    await expect(card).toContainText("运行中");

    // ③ 暂停继续条：达上限提示 + 继续按钮；点击后发出「继续」并收起
    const bar = page.locator(".continue-bar");
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("24 步");
    await bar.locator(".continue-btn").click();
    await expect(page.locator(".row-user").filter({ hasText: "继续" })).toBeVisible({ timeout: 20_000 });
    await expect(bar).toBeHidden({ timeout: 10_000 });
  } finally {
    kill(app);
    await rm(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
});

/** S1-3：普通 LLM 失败（非额度）→ 重试本轮 → 重发最后一轮用户输入。 */
test("普通 LLM 失败可重试本轮（S1-3）", async () => {
  test.setTimeout(90_000);
  const fakeHome = await mkdtemp(join(tmpdir(), "kcode-retry-"));
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
  const id = "sess_llm_retry";
  await writeFile(
    join(sessions, `${id}.jsonl`),
    [
      JSON.stringify({ v: 1, type: "session_start", ts: Date.now() - 60_000, sessionId: id, model: "mock/model", workspaceKey: kcodePath }),
      JSON.stringify({ v: 1, type: "user_message", ts: Date.now() - 59_000, sessionId: id, content: "重试这一轮" }),
      JSON.stringify({ v: 1, type: "llm_error", ts: Date.now() - 58_000, sessionId: id, error: "HTTP 404 Not Found" }),
      JSON.stringify({ v: 1, type: "session_end", ts: Date.now() - 57_000, sessionId: id, reason: "failed", usage: { inputTokens: 1, outputTokens: 1, calls: 1 } }),
    ].join("\n") + "\n",
    "utf8",
  );
  const env = {
    ...process.env,
    KCODE_HOME: kcodeHome,
    KCODE_DESKTOP_USER_DATA: join(fakeHome, "userData"),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const { app, page } = await launch(env);
  try {
    await page.locator(`[data-session-id="${id}"]`).click();
    const banner = page.locator(".row-llm-failed");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText("HTTP 404");
    await banner.locator(".llm-retry").click();
    // 重发最后一轮输入 → 新的 user_message 行出现（host 在 LLM 调用前落 user_message）
    await expect(page.locator(".row-user").filter({ hasText: "重试这一轮" })).toHaveCount(2, { timeout: 20_000 });
  } finally {
    kill(app);
    await rm(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
});

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

/** S1-4（F7/F18）：400px 浮动抽屉不占栏 + 三档宽度行为 + M8 大时间线帧率诊断。 */
test("context 抽屉浮动不占栏，三档宽度行为正确（S1-4）", async () => {
  test.setTimeout(120_000);
  const fakeHome = await mkdtemp(join(tmpdir(), "kcode-rsp-"));
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
  // M8 数据源：520 行大会话（user/assistant 交替）
  const bigId = "sess_big_rows";
  const bigEvents: Array<Record<string, unknown>> = [
    { v: 1, type: "session_start", ts: Date.now() - 90_000, sessionId: bigId, model: "mock/model", workspaceKey: kcodePath },
  ];
  for (let i = 0; i < 260; i += 1) {
    bigEvents.push({ v: 1, type: "user_message", ts: Date.now() - 89_000 + i, sessionId: bigId, content: `问题 ${i}` });
    bigEvents.push({ v: 1, type: "assistant_message", ts: Date.now() - 88_000 + i, sessionId: bigId, content: `回答 ${i}` });
  }
  await writeFile(
    join(sessions, `${bigId}.jsonl`),
    bigEvents.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
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
  const page = await app.firstWindow({ timeout: 20_000 });
  try {
    await page.addInitScript((value) => localStorage.setItem("kcode-last-cwd", value), kcodePath);
    await page.reload();
    await expect(page.locator(".desktop-v2")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".composer-mode")).toBeEnabled({ timeout: 20_000 });

    // —— 档一（≥1360）：抽屉浮动打开，主栏宽度不变（不占栏）
    await page.setViewportSize({ width: 1400, height: 900 });
    const mainBefore = await page.locator(".main-column").boundingBox();
    await page.locator(".wh-action", { hasText: "任务" }).click();
    const pane = page.locator(".side-pane-v2");
    await expect(pane).toBeVisible();
    const paneBox = await pane.boundingBox();
    expect(paneBox?.width).toBeCloseTo(400, 0); // CI 渲染有亚像素舍入（实测 399.99…）
    const paneStyle = await pane.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { position: cs.position, radius: cs.borderRadius, shadow: cs.boxShadow };
    });
    expect(paneStyle.position).toBe("absolute");
    expect(paneStyle.radius).toContain("12px");
    expect(paneStyle.shadow).not.toBe("none");
    const mainAfter = await page.locator(".main-column").boundingBox();
    expect(Math.abs((mainAfter?.width ?? 0) - (mainBefore?.width ?? 0))).toBeLessThanOrEqual(1);
    await page.locator(".side-pane-close").click();
    await expect(pane).toBeHidden();

    // —— 档二（1180–1359）：默认视口（1280）抽屉同样覆盖打开
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator(".wh-action", { hasText: "变更" }).click();
    await expect(pane).toBeVisible();
    await page.locator(".side-pane-close").click();

    // —— 档三（<1180）：侧栏收窄 225px、示例卡单列；<860 隐藏侧栏
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(page.locator(".workspace-sidebar")).toBeVisible();
    const narrowSidebar = await page.locator(".workspace-sidebar").boundingBox();
    expect(Math.round(narrowSidebar?.width ?? 0)).toBe(225);
    const promptsCols = await page.locator(".empty-prompts").evaluate(
      (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
    );
    expect(promptsCols).toBe(1);
    await page.setViewportSize({ width: 800, height: 700 });
    await expect(page.locator(".workspace-sidebar")).toBeHidden();
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.locator(".workspace-sidebar")).toBeVisible();

    // —— M8：520 行时间线挂载后的渲染帧率（诊断：目标 P95<33ms，此处守回归包络）
    await page.locator(`[data-session-id="${bigId}"]`).click();
    // 虚拟列表贴底渲染——断言最后一条（顶部行不在可视窗口）
    await expect(page.locator(".row-user").filter({ hasText: "问题 259" })).toBeVisible({ timeout: 20_000 });
    const innerHeight = await page.locator(".timeline-inner").evaluate((el) => el.getBoundingClientRect().height);
    expect(innerHeight).toBeGreaterThan(10_000);
    const frameP95 = await page.evaluate(async () => {
      const deltas: number[] = [];
      let last = performance.now();
      await new Promise<void>((resolve) => {
        const tick = (): void => {
          const now = performance.now();
          deltas.push(now - last);
          last = now;
          if (deltas.length >= 120) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      deltas.sort((a, b) => a - b);
      return deltas[Math.floor(deltas.length * 0.95)];
    });
    process.stdout.write(`[M8] 520 行时间线挂载后 rAF P95=${frameP95.toFixed(1)}ms（目标 33ms，包络 100ms）\n`);
    expect(frameP95).toBeLessThan(100);
  } finally {
    kill(app);
    await rm(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
});

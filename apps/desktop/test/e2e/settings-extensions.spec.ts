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

/** S1-6（F14 第一批）：扩展/使用统计子页 + provider 添加流程。 */
test("设置页扩展清单、插件安装启停、使用统计与添加供应商（S1-6）", async () => {
  test.setTimeout(120_000);
  const fakeHome = await mkdtemp(join(tmpdir(), "kcode-setext-"));
  const kcodeHome = join(fakeHome, ".kcode");
  const sessions = join(kcodeHome, "cli", "sessions");
  await mkdir(sessions, { recursive: true });
  await mkdir(join(kcodeHome, "desktop"), { recursive: true });
  await mkdir(join(kcodeHome, "skills", "demo"), { recursive: true });
  await mkdir(join(kcodeHome, "commands"), { recursive: true });
  // 插件源目录（本地安装用）
  const pluginSrc = join(fakeHome, "plugin-src");
  await mkdir(join(pluginSrc, "skills", "pskill"), { recursive: true });
  await writeFile(
    join(pluginSrc, ".kcode-plugin"),
    JSON.stringify({
      schema: "kcode.plugin/1",
      name: "my-plugin",
      version: "1.0.0",
      hooks: [],
      skills: ["pskill"],
      commands: [],
      agents: [],
      mcp: [],
      permissions: [],
    }),
    "utf8",
  );
  await writeFile(join(pluginSrc, "skills", "pskill", "SKILL.md"), "---\nname: pskill\ndescription: 插件技能\n---\nx", "utf8");
  await writeFile(join(kcodeHome, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: 演示技能\n---\n正文", "utf8");
  await writeFile(join(kcodeHome, "commands", "review.md"), "---\ndescription: 审查当前改动\n---\n内容", "utf8");
  await writeFile(
    join(kcodeHome, "mcp.json"),
    JSON.stringify({ servers: [{ name: "fs", transport: "stdio", command: "npx", args: ["-y", "fs-mcp"] }] }),
    "utf8",
  );
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
  const sid = "sess_usage_1";
  await writeFile(
    join(sessions, `${sid}.jsonl`),
    [
      JSON.stringify({ v: 1, type: "session_start", ts: 1, sessionId: sid, model: "mock/model", workspaceKey: kcodePath }),
      JSON.stringify({ v: 1, type: "session_end", ts: 2, sessionId: sid, reason: "completed", usage: { inputTokens: 1200, outputTokens: 300, calls: 4 } }),
    ].join("\n") + "\n",
    "utf8",
  );
  const env = {
    ...process.env,
    KCODE_HOME: kcodeHome,
    KCODE_DESKTOP_USER_DATA: join(fakeHome, "userData"),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({ args: ["dist/main.cjs", "--headless", "--no-sandbox", "--disable-gpu"], cwd, env });
  const page = await app.firstWindow({ timeout: 20_000 });
  const alerts: string[] = [];
  page.on("dialog", (dialog) => {
    alerts.push(dialog.message());
    void dialog.accept();
  });
  try {
    await page.addInitScript((value) => localStorage.setItem("kcode-last-cwd", value), kcodePath);
    await page.reload();
    await expect(page.locator(".desktop-v2")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".composer-mode")).toBeEnabled({ timeout: 20_000 });

    // 目录选择打桩：安装插件固定指向源目录
    await app.evaluate(({ dialog }, arg: { dir: string }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [arg.dir] });
    }, { dir: pluginSrc });

    // —— 扩展子页：安装本地插件 → 列表出现（未签名）→ 停用（state.json 落盘）
    await page.keyboard.press("Control+,");
    const settings = page.locator(".settings-v2");
    await expect(settings).toBeVisible({ timeout: 5_000 });
    await settings.getByRole("button", { name: "扩展" }).click();
    await settings.locator(".sv-ext-nav").getByRole("button", { name: "插件" }).click();
    await settings.locator(".sv-ext-install").click();
    await expect
      .poll(() => alerts.some((m) => m.includes("已安装 my-plugin")), { timeout: 15_000 })
      .toBe(true);
    const pluginRow = settings.locator('[data-plugin="my-plugin"]');
    await expect(pluginRow).toBeVisible();
    await expect(pluginRow).toContainText("1.0.0");
    await expect(pluginRow).toContainText("未签名");
    await pluginRow.getByRole("button", { name: "停用" }).click();
    await expect(pluginRow.getByRole("button", { name: "启用" })).toBeVisible({ timeout: 10_000 });
    const state = JSON.parse(await readFile(join(kcodeHome, "cli", "plugins", "state.json"), "utf8")) as {
      disabled: string[];
    };
    expect(state.disabled).toContain("my-plugin");
    await pluginRow.getByRole("button", { name: "启用" }).click();
    await expect(pluginRow.getByRole("button", { name: "停用" })).toBeVisible({ timeout: 10_000 });

    // —— 技能 / 命令 / MCP 分区
    await settings.locator(".sv-ext-nav").getByRole("button", { name: "技能" }).click();
    await expect(settings.locator('[data-skill="demo"]')).toBeVisible();
    await expect(settings.locator('[data-skill="pskill"]')).toBeVisible();
    await settings.locator(".sv-ext-nav").getByRole("button", { name: "命令" }).click();
    await expect(settings.locator('[data-command="review"]')).toBeVisible();
    await settings.locator(".sv-ext-nav").getByRole("button", { name: "MCP" }).click();
    await expect(settings.locator('[data-mcp="fs"]')).toContainText("stdio");

    // —— 使用统计：估算账本
    await settings.getByRole("button", { name: "使用统计" }).click();
    const usage = settings.locator(".sv-usage");
    await expect(usage).toBeVisible();
    await expect(usage).toContainText("1.2k");
    await expect(usage.locator('[data-model="mock/model"]')).toBeVisible();
    await expect(usage).toContainText("估算");

    // —— 添加供应商：预设 + 保存 → 出现在本地 Provider 列表
    await settings.getByRole("button", { name: "模型" }).click();
    const add = settings.locator(".sv-provider-add");
    await expect(add).toBeVisible();
    await add.locator(".sv-preset-grid").getByRole("button", { name: /deepseek/ }).click();
    await add.locator("input").nth(2).fill("sk-test-key");
    await add.getByRole("button", { name: "保存供应商" }).click();
    await expect
      .poll(() => settings.locator(".sv-provider-item").filter({ hasText: "deepseek" }).count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
  } finally {
    kill(app);
    await rm(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
});

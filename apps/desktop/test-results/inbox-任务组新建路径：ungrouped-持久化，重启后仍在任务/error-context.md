# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: inbox.spec.ts >> 任务组新建路径：ungrouped 持久化，重启后仍在任务
- Location: test\e2e\inbox.spec.ts:41:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('.row-user').filter({ hasText: '任务组会话' })
Expected: visible
Timeout: 20000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" locator('.row-user').filter({ hasText: '任务组会话' }) with timeout 20000ms
  - waiting for locator('.row-user').filter({ hasText: '任务组会话' })

```

```yaml
- complementary:
  - text: kcode 本地
  - button "对话"
  - button "自动化"
  - button "插件市场"
  - button "新建会话 ⌘N"
  - button "工作区"
  - button "搜索工作区或任务"
  - button "按名称排序"
  - button "添加工作区"
  - button "kcode":
    - text: kcode
    - button "新建任务"
    - button "工作区操作"
  - text: 暂无任务
  - button "任务"
  - button "新任务 刚刚":
    - text: 新任务 刚刚
    - button "任务操作"
  - button "设置"
- separator
- banner:
  - text: kcode E:/space/my_space/MyProject/kcode mock/model ⏵ 变更确认
  - button "变更"
  - button "任务"
  - button "打开文件夹"
- status:
  - strong: 工作区尚未信任
  - text: AGENTS.md、规则与项目技能尚未装载。信任后对新会话生效。
  - button "信任本工作区"
  - button "关闭"
- text: k KCODE WORKSPACE
- heading "开始一个任务" [level=1]
- paragraph: 读代码、改实现、跑测试，或者把一堆材料整理成可交付的结果。
- button "理解这个仓库 架构、入口、关键模块":
  - strong: 理解这个仓库
  - text: 架构、入口、关键模块
- button "修复一个 bug 定位、修改、验证":
  - strong: 修复一个 bug
  - text: 定位、修改、验证
- button "生成变更摘要 diff、测试、风险":
  - strong: 生成变更摘要
  - text: diff、测试、风险
- text: 当前工作区 kcode
- textbox "描述任务，Enter 发送 · / 命令 · @ 文件 · Shift+Enter 换行"
- button "添加图片（最多 8 张）"
- combobox "权限模式":
  - option "⏸ 只读"
  - option "⏵ 变更确认" [selected]
  - option "⏵⏵ 自动编辑"
  - option "⏵⏵⏵ 完全访问"
- img "上下文 0%"
- button "model"
- button "发送（Enter）" [disabled]
```

# Test source

```ts
  1   | import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
  2   | 
  3   | // CI 共享 2 核 runner 上 dispose/create 竞态偶发（本地稳定）；重试上限放宽到 2
  4   | test.describe.configure({ retries: 2 });
  5   | import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
  6   | import { tmpdir } from "node:os";
  7   | import { join } from "node:path";
  8   | import { fileURLToPath } from "node:url";
  9   | import { spawnSync } from "node:child_process";
  10  | 
  11  | const cwd = fileURLToPath(new URL("../..", import.meta.url));
  12  | /** S0-2：仓库根从模块 URL 推导（正斜杠、无尾斜杠，与原硬编码一致）；KCODE_E2E_REPO 可覆盖 */
  13  | const repoRoot = (): string => {
  14  |   const p = decodeURIComponent(new URL("../../../..", import.meta.url).pathname);
  15  |   const noDrive = process.platform === "win32" ? p.slice(1) : p;
  16  |   return noDrive.endsWith("/") ? noDrive.slice(0, -1) : noDrive;
  17  | };
  18  | const kcodePath = process.env["KCODE_E2E_REPO"] ?? repoRoot();
  19  | 
  20  | function kill(app: ElectronApplication): void {
  21  |   const pid = app.process().pid;
  22  |   if (pid === undefined) return;
  23  |   if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  24  |   else process.kill(-pid, "SIGKILL");
  25  | }
  26  | 
  27  | async function launch(env: Record<string, string | undefined>): Promise<{ app: ElectronApplication; page: Page }> {
  28  |   const app = await electron.launch({
  29  |     args: ["dist/main.cjs", "--headless", "--no-sandbox", "--disable-gpu"],
  30  |     cwd,
  31  |     env,
  32  |   });
  33  |   const page = await app.firstWindow({ timeout: 20_000 });
  34  |   await page.addInitScript((value) => localStorage.setItem("kcode-last-cwd", value), kcodePath);
  35  |   await page.reload();
  36  |   await expect(page.locator(".desktop-v2")).toBeVisible({ timeout: 20_000 });
  37  |   await expect(page.locator(".composer-input")).toBeEnabled({ timeout: 20_000 });
  38  |   return { app, page };
  39  | }
  40  | 
  41  | test("任务组新建路径：ungrouped 持久化，重启后仍在任务", async () => {
  42  |   test.setTimeout(90_000);
  43  |   const fakeHome = await mkdtemp(join(tmpdir(), "kcode-inbox-"));
  44  |   const kcodeHome = join(fakeHome, ".kcode");
  45  |   await mkdir(join(kcodeHome, "cli", "sessions"), { recursive: true });
  46  |   await mkdir(join(kcodeHome, "desktop"), { recursive: true });
  47  |   await writeFile(
  48  |     join(kcodeHome, "config.json"),
  49  |     JSON.stringify({
  50  |       models: {
  51  |         default: "mock/model",
  52  |         providers: { mock: { type: "openai-compatible", baseURL: "https://example.com/v1" } },
  53  |       },
  54  |     }),
  55  |     "utf8",
  56  |   );
  57  |   await writeFile(
  58  |     join(kcodeHome, "desktop", "projects.json"),
  59  |     JSON.stringify({
  60  |       version: 1,
  61  |       workspaces: [{ path: kcodePath, name: "kcode", createdAt: Date.now(), updatedAt: Date.now() }],
  62  |     }),
  63  |     "utf8",
  64  |   );
  65  |   const env = {
  66  |     ...process.env,
  67  |     KCODE_HOME: kcodeHome,
  68  |     KCODE_DESKTOP_USER_DATA: join(fakeHome, "userData"),
  69  |   };
  70  |   delete env.ELECTRON_RUN_AS_NODE;
  71  | 
  72  |   const first = await launch(env);
  73  |   try {
  74  |     await first.page.locator(".d2-inbox .d2-label").click();
  75  |     await first.page.locator(".d2-new").click();
  76  |     await first.page.locator(".composer-input").fill("任务组会话");
  77  |     await expect(first.page.locator(".composer-send")).toBeEnabled({ timeout: 10_000 });
  78  |     await first.page.locator(".composer-input").press("Enter");
  79  |     // 前提：提交真的进来了（user_message 行先于侧栏刷新出现）；失败即 submit 被吞，而非列表问题
> 80  |     await expect(first.page.locator(".row-user").filter({ hasText: "任务组会话" })).toBeVisible({ timeout: 20_000 });
      |                                                                                ^ Error: expect(locator).toBeVisible() failed
  81  |     const inboxTask = first.page.locator(".d2-inbox .d2-task").filter({ hasText: "任务组会话" });
  82  |     // 提交 → user_message → sessions/changed → 侧栏重拉全链路：CI 慢机（2 核）给足余量
  83  |     await expect(inboxTask).toBeVisible({ timeout: 30_000 });
  84  |     const inboxId = await inboxTask.getAttribute("data-session-id");
  85  |     expect(inboxId).not.toBeNull();
  86  |     const projectIds = await first.page
  87  |       .locator(".d2-project .d2-task")
  88  |       .evaluateAll((els) => els.map((element) => element.getAttribute("data-session-id")));
  89  |     expect(projectIds).not.toContain(inboxId);
  90  |   } finally {
  91  |     kill(first.app);
  92  |   }
  93  |   await new Promise((resolve) => setTimeout(resolve, 500));
  94  | 
  95  |   const second = await launch(env);
  96  |   try {
  97  |     await second.page.locator(".d2-inbox .d2-label").click();
  98  |     await expect(
  99  |       second.page.locator(".d2-inbox .d2-task").filter({ hasText: "任务组会话" }),
  100 |     ).toBeVisible({ timeout: 20_000 });
  101 |   } finally {
  102 |     kill(second.app);
  103 |     await rm(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  104 |   }
  105 | });
  106 | 
```
# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: ordering.spec.ts >> 点击旧会话不会把它顶到前面或改成刚刚
- Location: test\e2e\ordering.spec.ts:17:1

# Error details

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  - 4
+ Received  + 1

- Array [
-   "新会话",
-   "旧会话",
- ]
+ Array []
```

# Test source

```ts
  1  | import { test, expect, _electron as electron } from "@playwright/test";
  2  | import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
  3  | import { tmpdir } from "node:os";
  4  | import { join } from "node:path";
  5  | import { fileURLToPath } from "node:url";
  6  | import { spawnSync } from "node:child_process";
  7  | 
  8  | const cwd = fileURLToPath(new URL("../..", import.meta.url));
  9  | /** S0-2：仓库根从模块 URL 推导（正斜杠、无尾斜杠，与原硬编码一致）；KCODE_E2E_REPO 可覆盖 */
  10 | const repoRoot = (): string => {
  11 |   const p = decodeURIComponent(new URL("../../../..", import.meta.url).pathname);
  12 |   const noDrive = process.platform === "win32" ? p.slice(1) : p;
  13 |   return noDrive.endsWith("/") ? noDrive.slice(0, -1) : noDrive;
  14 | };
  15 | const kcodePath = process.env["KCODE_E2E_REPO"] ?? repoRoot();
  16 | 
  17 | test("点击旧会话不会把它顶到前面或改成刚刚", async () => {
  18 |   test.setTimeout(60_000);
  19 |   const fakeHome = await mkdtemp(join(tmpdir(), "kcode-order-"));
  20 |   const kcodeHome = join(fakeHome, ".kcode");
  21 |   const sessions = join(kcodeHome, "cli", "sessions");
  22 |   await mkdir(sessions, { recursive: true });
  23 |   await mkdir(join(kcodeHome, "desktop"), { recursive: true });
  24 |   await writeFile(
  25 |     join(kcodeHome, "config.json"),
  26 |     JSON.stringify({
  27 |       models: {
  28 |         default: "mock/model",
  29 |         providers: { mock: { type: "openai-compatible", baseURL: "https://example.com/v1" } },
  30 |       },
  31 |     }),
  32 |     "utf8",
  33 |   );
  34 |   await writeFile(
  35 |     join(kcodeHome, "desktop", "projects.json"),
  36 |     JSON.stringify({
  37 |       version: 1,
  38 |       workspaces: [{ path: kcodePath, name: "kcode", createdAt: Date.now(), updatedAt: Date.now() }],
  39 |     }),
  40 |     "utf8",
  41 |   );
  42 |   const writeSession = async (id: string, title: string, ageMs: number): Promise<void> => {
  43 |     const ts = Date.now() - ageMs;
  44 |     const file = join(sessions, `${id}.jsonl`);
  45 |     await writeFile(
  46 |       file,
  47 |       [
  48 |         JSON.stringify({ v: 1, type: "session_start", ts, sessionId: id, model: "mock/model", workspaceKey: kcodePath }),
  49 |         JSON.stringify({ v: 1, type: "user_message", ts: ts + 1, sessionId: id, content: title }),
  50 |         JSON.stringify({ v: 1, type: "assistant_message", ts: ts + 2, sessionId: id, content: "ok" }),
  51 |       ].join("\n") + "\n",
  52 |       "utf8",
  53 |     );
  54 |     await utimes(file, new Date(ts), new Date(ts));
  55 |   };
  56 |   await writeSession("sess_order_new", "新会话", 60 * 60_000);
  57 |   await writeSession("sess_order_old", "旧会话", 3 * 24 * 60 * 60_000);
  58 |   const env = {
  59 |     ...process.env,
  60 |     KCODE_HOME: kcodeHome,
  61 |     KCODE_DESKTOP_USER_DATA: join(fakeHome, "userData"),
  62 |   };
  63 |   delete env.ELECTRON_RUN_AS_NODE;
  64 |   const app = await electron.launch({
  65 |     args: ["dist/main.cjs", "--headless", "--no-sandbox", "--disable-gpu"],
  66 |     cwd,
  67 |     env,
  68 |   });
  69 |   try {
  70 |     const page = await app.firstWindow({ timeout: 20_000 });
  71 |     await page.addInitScript((value) => localStorage.setItem("kcode-last-cwd", value), kcodePath);
  72 |     await page.reload();
  73 |     await expect(page.locator(".desktop-v2")).toBeVisible({ timeout: 20_000 });
  74 |     await expect(page.locator(".composer-input")).toBeEnabled({ timeout: 20_000 });
  75 |     const kcode = page.locator(".d2-project").filter({ hasText: "kcode" }).first();
  76 |     const before = (await kcode.locator(".d2-task-title").allTextContents()).filter((title) => title !== "新任务");
> 77 |     expect(before).toEqual(["新会话", "旧会话"]);
     |                    ^ Error: expect(received).toEqual(expected) // deep equality
  78 |     await kcode.locator('[data-session-id="sess_order_old"]').click();
  79 |     await expect(page.locator(".row-user")).toBeVisible({ timeout: 20_000 });
  80 |     const ids = await kcode
  81 |       .locator(".d2-task")
  82 |       .evaluateAll((els) =>
  83 |         els
  84 |           .map((element) => element.getAttribute("data-session-id"))
  85 |           .filter((id): id is string => id?.startsWith("sess_order_") === true),
  86 |       );
  87 |     expect(ids).toEqual(["sess_order_new", "sess_order_old"]);
  88 |   } finally {
  89 |     const pid = app.process().pid;
  90 |     if (pid !== undefined) {
  91 |       if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  92 |       else process.kill(-pid, "SIGKILL");
  93 |     }
  94 |     await rm(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  95 |   }
  96 | });
  97 | 
```
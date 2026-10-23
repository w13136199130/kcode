#!/usr/bin/env node
/**
 * 桌面 dev 编排（M1）：host/main/preload 打包 → vite dev server 就绪 → 启动 electron。
 * 无额外依赖（wait-on 不引入）：轮询 dev server 端口就绪即拉起。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function run(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  p.on("exit", (code) => {
    if (code !== 0 && cmd !== "electron") process.exit(code ?? 1);
  });
  return p;
}

// 1) host + main/preload 构建（顺序：host 先——main 的 fork 指向其产物）
const hostBuild = spawnSync("pnpm", ["--filter", "@kcode/host", "build"], { stdio: "inherit", shell: true });
if (hostBuild.status !== 0) process.exit(1);
const mainBuild = spawnSync("npx", ["tsup"], { stdio: "inherit", shell: true, cwd: root });
if (mainBuild.status !== 0) process.exit(1);
if (!existsSync(join(root, "dist/main.cjs")) || !existsSync(join(root, "../host/dist/port.cjs"))) {
  process.stderr.write("✗ 构建产物缺失（dist/main.cjs / host/dist/port.cjs）\n");
  process.exit(1);
}

// 2) vite dev server（后台）
const vite = run("npx", ["vite", "--port", "5199", "--strictPort"], { cwd: root });
const devUrl = "http://localhost:5199";

// 3) 等 vite 就绪再拉 electron
const waitReady = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(devUrl);
      if (res.ok) return true;
    } catch {
      // 还没起
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

void waitReady().then((ok) => {
  if (!ok) {
    process.stderr.write(`✗ vite dev server 90s 未就绪（${devUrl}）\n`);
    vite.kill();
    process.exit(1);
  }
  const electronEnv = {
    ...process.env,
    KCODE_DESKTOP_DEV_URL: devUrl,
    // Windows 上默认 userData 的 SingletonLock 可能因 ACL/安全策略创建失败；
    // dev 使用独立目录，避免把本地启动卡在 Chromium process singleton。
    KCODE_DESKTOP_USER_DATA:
      process.env.KCODE_DESKTOP_USER_DATA ?? join(root, "dist", "dev-user-data"),
  };
  // 某些 shell / agent 环境会设置 ELECTRON_RUN_AS_NODE=1——Electron 会退化成 Node 并以
  // 0x80000003 退出。启动窗口前显式清掉，避免本地 dev 被环境变量误伤。
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const electronArgs = ["electron", "dist/main.cjs"];
  // Windows 本地开发环境可能在受限会话里起 Chromium sandbox/GPU；显式降级只影响 dev。
  if (process.platform === "win32") electronArgs.push("--no-sandbox", "--disable-gpu");
  const electron = run("npx", electronArgs, {
    cwd: root,
    env: electronEnv,
  });
  electron.on("exit", () => vite.kill());
});

process.on("SIGINT", () => {
  vite.kill();
  process.exit(0);
});

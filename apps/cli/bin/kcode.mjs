#!/usr/bin/env node
/**
 * kcode 全局启动器：任意目录可用。
 * 关键点：tsx 从本包（apps/cli）的依赖解析（createRequire 锁定解析上下文），
 * 但不改动子进程 cwd —— 会话工作目录必须是用户当前目录。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(cliDir, "src", "main.tsx");

let tsxImport;
try {
  tsxImport = createRequire(join(cliDir, "package.json")).resolve("tsx");
} catch {
  console.error("✗ 未解析到 tsx 依赖：请在仓库内执行 pnpm install 后重试");
  process.exit(1);
}

const child = spawn(
  process.execPath,
  // Windows 绝对路径给 --import 必须是 file:// URL（"E:\..." 会被当成协议头）
  ["--import", pathToFileURL(tsxImport).href, entry, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: { ...process.env },
    windowsHide: false,
  },
);
child.on("error", (err) => {
  console.error(`✗ 启动失败：${err.message}`);
  process.exit(1);
});
child.on("close", (code) => {
  process.exit(code ?? 0);
});

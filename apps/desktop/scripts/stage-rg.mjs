#!/usr/bin/env node
/**
 * 打包前置：把 @vscode/ripgrep 及其平台二进制包（optionalDependencies——rg.exe 真身）
 * 的真实目录（pnpm symlink 目标）拷到 build/rg-stage——electron-builder 的
 * extraResources 不跟随 workspace symlink（M3c 实测），且打包态 host 在 asar 外
 * require('@vscode/ripgrep') 需要实体 node_modules。
 */
import { cpSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// @vscode/ripgrep 的 exports 不含 ./package.json——直接解析入口再取目录
const rgEntry = require.resolve("@vscode/ripgrep");
// realpath 必须做：pnpm 在 Windows 用 junction，require.resolve 会保留链接路径——
// 不 realpath 的话 cpSync 拷出来是相对 symlink，打包后指向不存在的位置（M3c 实测）
const pkgDir = realpathSync(dirname(dirname(rgEntry))); // lib/ → 包根（真身）
const stageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "rg-stage", "@vscode");

// 平台二进制包：pnpm 布局下与 ripgrep 同目录并列（.pnpm/@vscode+ripgrep@x/node_modules/@vscode/ 下），
// 且其 exports 拦 package.json 解析——不能用 require.resolve 探测，直接列兄弟目录
rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageRoot, { recursive: true });
cpSync(pkgDir, join(stageRoot, "ripgrep"), { recursive: true });
const siblings = readdirSync(dirname(pkgDir)).filter((n) => n.startsWith("ripgrep-"));
for (const name of siblings) {
  cpSync(realpathSync(join(dirname(pkgDir), name)), join(stageRoot, name), { recursive: true });
  console.log(`✓ @vscode/${name} staged`);
}
console.log(`✓ @vscode/ripgrep staged → ${stageRoot}`);

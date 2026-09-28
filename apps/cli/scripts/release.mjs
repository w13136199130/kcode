#!/usr/bin/env node
/**
 * kcode 发行链（N2-4）：构建 → 组装 → tar.gz → sha256 → latest.json。
 * 用法：node scripts/release.mjs [--version x.y.z]
 * 产物：dist/release/kcode-<ver>-<platform>-<arch>.tar.gz（+.sha256 + latest.json）
 * 运行环境要求 Node ≥22（无 npm 依赖、无 tsx）；rg 二进制为构建机平台。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const versionArg = args.includes("--version") ? args[args.indexOf("--version") + 1] : undefined;

const pkg = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
const version = versionArg ?? pkg.version;
const platform = `${process.platform}-${process.arch}`;
const releaseName = `kcode-${version}-${platform}`;
const outDir = join(cliDir, "dist", "release");
const stageDir = join(outDir, releaseName);

// 1) 构建（tsup 含伴生资产复制：yoga.wasm + ripgrep 平台包）
// Windows 下直接 spawn npx.cmd 会被 Node 安全策略拦（EINVAL），统一走 shell
const build = spawnSync("npx tsup", { cwd: cliDir, stdio: "inherit", shell: true });
if (build.status !== 0) {
  console.error("✗ 构建失败（tsup）");
  process.exit(1);
}

// 2) 组装 staging 目录
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
for (const asset of ["kcode.mjs", "yoga.wasm", "node_modules"]) {
  const from = join(cliDir, "dist", asset);
  if (!existsSync(from)) {
    console.error(`✗ 缺少构建产物 ${asset}（tsup onSuccess 应产出）`);
    process.exit(1);
  }
  cpSync(from, join(stageDir, asset), { recursive: true });
}
cpSync(join(cliDir, "..", "..", "LICENSE"), join(stageDir, "LICENSE"));
cpSync(join(cliDir, "..", "..", "README.md"), join(stageDir, "README.md"));
// 最小 package.json：type=module 保证 .mjs 语义；bin 供 npm i -g 解包目录使用
writeFileSync(
  join(stageDir, "package.json"),
  `${JSON.stringify({ name: "kcode", version, type: "module", bin: { kcode: "kcode.mjs" } }, null, 2)}\n`,
);

// 3) tar.gz（bsdtar/GNU tar 通用参数；顶层带 kcode-<ver>-<plat>/ 目录）
const tarball = `${releaseName}.tar.gz`;
const tar = spawnSync("tar", ["-czf", tarball, releaseName], { cwd: outDir, stdio: "inherit" });
if (tar.status !== 0) {
  console.error("✗ tar 打包失败（Windows 需 Win10+ 自带 bsdtar）");
  process.exit(1);
}

// 4) sha256（与 shasum -a 256 同格式，安装脚本按文件名校验）
const hash = createHash("sha256").update(readFileSync(join(outDir, tarball))).digest("hex");
writeFileSync(join(outDir, `${tarball}.sha256`), `${hash}  ${tarball}\n`);

// 5) latest.json（自更新/安装脚本的通道元数据）
const stats = (await import("node:fs")).statSync(join(outDir, tarball));
writeFileSync(
  join(outDir, "latest.json"),
  `${JSON.stringify(
    {
      name: "kcode",
      version,
      platform,
      node: ">=22",
      date: new Date().toISOString(),
      tarball,
      sha256: hash,
      size: stats.size,
    },
    null,
    2,
  )}\n`,
);

console.log(`✓ 发行产物（${outDir}）：
  ${tarball}（${(stats.size / 1024 / 1024).toFixed(1)} MB）
  ${tarball}.sha256
  latest.json（version=${version} platform=${platform}）`);

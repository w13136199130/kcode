import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * kcode update（N3E-4）：latest.json 通道的自更新消费方——zcode 实测无 TUF
 * （`releaseDownload.ts:137` 仅 SHA-256+尺寸校验），kcode 与之同级：
 * 校验 sha256/尺寸 → 解包 ~/.kcode/releases/<ver> → 翻 current 指针（Junction/软链）。
 * 源支持 http(s) URL 或本地路径（latest.json 与 tarball 同目录），经 --url 或 KCODE_UPDATE_URL。
 */

interface LatestMeta {
  name: string;
  version: string;
  platform: string;
  tarball: string;
  sha256: string;
  size: number;
}

type Write = (line: string) => void;

/**
 * Windows 上 PATH 首位常是 Git 的 GNU tar——它把 "C:\..." 当远程主机（Cannot connect to C:）。
 * 显式用 System32 的 bsdtar（Win10+ 自带，原生支持 Windows 路径）；缺失时回退 PATH。
 */
export function tarBinary(): string {
  if (process.platform === "win32") {
    const bsd = join(process.env["SystemRoot"] ?? "C:\Windows", "System32", "tar.exe");
    return existsSync(bsd) ? bsd : "tar";
  }
  return "tar";
}

function semverGt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

async function readLatest(source: string): Promise<LatestMeta> {
  let text: string;
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`拉取 ${source} 失败：HTTP ${res.status}`);
    }
    text = await res.text();
  } else {
    text = await readFile(source, "utf8");
  }
  const meta = JSON.parse(text) as LatestMeta;
  for (const field of ["name", "version", "platform", "tarball", "sha256", "size"] as const) {
    if (meta[field] === undefined) {
      throw new Error(`latest.json 缺字段 ${field}`);
    }
  }
  return meta;
}

async function fetchTarball(tarballUrl: string, target: string): Promise<void> {
  if (/^https?:\/\//i.test(tarballUrl)) {
    const res = await fetch(tarballUrl);
    if (!res.ok) {
      throw new Error(`下载失败：HTTP ${res.status}`);
    }
    await writeFile(target, Buffer.from(await res.arrayBuffer()));
    return;
  }
  await writeFile(target, await readFile(tarballUrl));
}

export async function updateCommand(
  args: string[],
  write: Write,
  opts: { kcodeHomeDir?: string; currentVersion?: string } = {},
): Promise<boolean> {
  const home = opts.kcodeHomeDir ?? join(homedir(), ".kcode");
  const currentVersion = opts.currentVersion ?? process.env["KCODE_VERSION"] ?? "dev";
  const force = args.includes("--force");
  const urlFlag = args.includes("--url") ? args[args.indexOf("--url") + 1] : undefined;
  const source = urlFlag ?? process.env["KCODE_UPDATE_URL"];
  if (source === undefined || source === "") {
    write("✗ 未配置更新源：kcode update --url <latest.json 的 URL 或本地路径>（或环境变量 KCODE_UPDATE_URL）");
    return false;
  }

  const meta = await readLatest(source);
  write(`✓ 通道：${meta.name} 最新 ${meta.version}（${meta.platform}，${(meta.size / 1024 / 1024).toFixed(1)} MB）`);
  if (meta.platform !== `${process.platform}-${process.arch}`) {
    write(`✗ 平台不匹配：通道为 ${meta.platform}，本机为 ${process.platform}-${process.arch}（--force 跳过检查）`);
    if (!force) return false;
  }
  if (!force && (currentVersion === meta.version || !semverGt(meta.version, currentVersion))) {
    write(`✓ 已是最新（当前 ${currentVersion}）——无需更新`);
    return true;
  }

  // tarball 与 latest.json 同目录（URL 取基路径，本地取 dirname）
  const tarballUrl = /^https?:\/\//i.test(source)
    ? `${source.slice(0, source.lastIndexOf("/") + 1)}${meta.tarball}`
    : join(dirname(source), meta.tarball);
  const tmp = join(home, "tmp");
  mkdirSync(tmp, { recursive: true });
  const part = join(tmp, `${meta.tarball}.part-${process.pid}`);
  write(`↓ 下载 ${tarballUrl} …`);
  await fetchTarball(tarballUrl, part);

  // 校验：尺寸精确 + SHA-256 全文件比对（对标 zcode releaseDownload.ts:137）
  const bytes = readFileSync(part);
  if (bytes.length !== meta.size) {
    rmSync(part, { force: true });
    write(`✗ 尺寸不符：期望 ${meta.size}，实际 ${bytes.length}`);
    return false;
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== meta.sha256) {
    rmSync(part, { force: true });
    write(`✗ SHA-256 不符：期望 ${meta.sha256.slice(0, 16)}…，实际 ${sha.slice(0, 16)}…`);
    return false;
  }
  write("✓ 校验通过（size + sha256）");

  // 解包到 releases/<ver>（先解到临时目录，成功后原子换名——失败不留半装目录）
  const releases = join(home, "releases");
  const relName = `kcode-${meta.version}`;
  const target = join(releases, relName);
  const staging = join(releases, `${relName}.staging`);
  rmSync(staging, { recursive: true, force: true });
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(staging, { recursive: true });
  const tar = spawnSync(tarBinary(), ["-xzf", part, "-C", staging], { windowsHide: true });
  rmSync(part, { force: true });
  if (tar.status !== 0) {
    rmSync(staging, { recursive: true, force: true });
    write(`✗ 解包失败：tar 退出码 ${tar.status}`);
    return false;
  }
  // 平铺结构由 release.mjs 打包保证（kcode.mjs 在 tarball 根）；staging 原子换名
  const { renameSync } = await import("node:fs");
  renameSync(staging, target);

  // 翻 current 指针（Windows Junction / POSIX 软链）——与 install.ps1/install.sh 同机制
  const current = join(releases, "current");
  rmSync(current, { recursive: true, force: true });
  const { symlinkSync } = await import("node:fs");
  symlinkSync(target, current, process.platform === "win32" ? "junction" : "dir");
  write(`✓ 已安装 ${meta.version} → ${target}——重启 kcode 生效（原 ${currentVersion}）`);
  return true;
}

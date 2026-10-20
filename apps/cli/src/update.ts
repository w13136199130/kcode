import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
  /** 可选：对 tarball 原始字节的 Ed25519 签名（base64）。配置公钥时强制校验 */
  signature?: string;
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

/** 2-19：更新源只允许 https（远程）；本地路径必须显式 --local */
function assertHttps(url: string, label: string): void {
  if (!/^https:\/\//i.test(url)) {
    throw new Error(`${label} 必须是 https URL（收到 ${url}）`);
  }
}

/** tar 条目路径安全：拒绝绝对路径、盘符、.. 段 */
export function isSafeTarEntry(entry: string): boolean {
  const normalized = entry.replace(/\\/g, "/");
  if (normalized === "" || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return false;
  return !normalized.split("/").includes("..");
}

/** 解包前用 tar -tvzf 列条目：路径安全 + 拒绝符号链接/硬链接（可借链写出 staging） */
function validateTarEntries(archive: string): void {
  const listed = spawnSync(tarBinary(), ["-tvzf", archive], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (listed.status !== 0) {
    throw new Error(`tar -tvzf 失败（退出码 ${listed.status}）`);
  }
  for (const line of listed.stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    if (/^[lh]/i.test(line.trim())) {
      throw new Error(`tarball 含链接条目，拒绝解包：${line.trim()}`);
    }
    // 末尾是条目名；GNU/bsdtar 的 -tvzf 都是 "权限 ... 名字"
    const name = line.trim().split(/\s+/).at(-1) ?? "";
    if (!isSafeTarEntry(name)) {
      throw new Error(`tarball 含越界路径，拒绝解包：${name}`);
    }
  }
}

function readPublicKey(pathOrPem: string | undefined): ReturnType<typeof createPublicKey> | null {
  if (pathOrPem === undefined || pathOrPem === "") return null;
  const pem = existsSync(pathOrPem) ? readFileSync(pathOrPem, "utf8") : pathOrPem;
  return createPublicKey(pem);
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

function currentTarget(releases: string): string | null {
  const current = join(releases, "current");
  try {
    return readlinkSync(current);
  } catch {
    return null;
  }
}

function pointCurrent(releases: string, target: string): void {
  const current = join(releases, "current");
  const tmp = join(releases, "current.tmp");
  rmSync(tmp, { recursive: true, force: true });
  symlinkSync(target, tmp, process.platform === "win32" ? "junction" : "dir");
  rmSync(current, { recursive: true, force: true });
  renameSync(tmp, current);
}

interface PreviousRelease {
  target: string;
  version: string;
}

function readPrevious(releases: string): PreviousRelease | null {
  try {
    return JSON.parse(readFileSync(join(releases, "previous.json"), "utf8")) as PreviousRelease;
  } catch {
    return null;
  }
}

function writePrevious(releases: string, previous: PreviousRelease | null): void {
  const path = join(releases, "previous.json");
  if (previous === null) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(releases, { recursive: true });
  writeFileSyncAtomic(path, `${JSON.stringify(previous, null, 2)}\n`);
}

function writeFileSyncAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
  try {
    writeFileSync(`${path}.bak`, readFileSync(path));
  } catch {
    // 首次安装无旧文件
  }
  try {
    renameSync(tmp, path);
  } catch {
    rmSync(path, { force: true });
    renameSync(tmp, path);
  }
}

function rollback(home: string, write: Write): boolean {
  const releases = join(home, "releases");
  const previous = readPrevious(releases);
  if (previous === null || !existsSync(previous.target)) {
    write("✗ 没有可回滚的上一版（先成功执行一次 kcode update）");
    return false;
  }
  const current = currentTarget(releases);
  pointCurrent(releases, previous.target);
  writePrevious(
    releases,
    current !== null && existsSync(current)
      ? { target: current, version: basename(current).replace(/^kcode-/, "") }
      : null,
  );
  write(`✓ 已回滚到 ${previous.version}（${previous.target}）——重启 kcode 生效`);
  return true;
}

export async function updateCommand(
  args: string[],
  write: Write,
  opts: { kcodeHomeDir?: string; currentVersion?: string } = {},
): Promise<boolean> {
  const home = opts.kcodeHomeDir ?? join(homedir(), ".kcode");
  const currentVersion = opts.currentVersion ?? process.env["KCODE_VERSION"] ?? "dev";
  const force = args.includes("--force");
  if (args.includes("--rollback")) {
    return rollback(home, write);
  }
  const local = args.includes("--local");
  const urlFlag = args.includes("--url") ? args[args.indexOf("--url") + 1] : undefined;
  const source = urlFlag ?? process.env["KCODE_UPDATE_URL"];
  if (source === undefined || source === "") {
    write("✗ 未配置更新源：kcode update --url <https://…/latest.json>（或本地路径 + --local）");
    return false;
  }
  const remote = /^https?:\/\//i.test(source);
  if (remote) {
    assertHttps(source, "更新源");
  } else if (!local) {
    write("✗ 本地更新源需显式 --local（防误把本地路径当远程通道）");
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

  // tarball 与 latest.json 同目录；拒绝路径穿越/远程 http
  if (basename(meta.tarball) !== meta.tarball || meta.tarball.includes("..") || meta.tarball.includes("\\")) {
    write(`✗ latest.json 的 tarball 字段含路径：${meta.tarball}`);
    return false;
  }
  const tarballUrl = remote
    ? `${source.slice(0, source.lastIndexOf("/") + 1)}${meta.tarball}`
    : join(dirname(source), meta.tarball);
  if (remote) assertHttps(tarballUrl, "tarball");
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
  const pubkeyFlag = args.includes("--pubkey") ? args[args.indexOf("--pubkey") + 1] : undefined;
  const pubkey = readPublicKey(pubkeyFlag ?? process.env["KCODE_UPDATE_PUBKEY"]);
  if (pubkey !== null) {
    if (meta.signature === undefined || meta.signature === "") {
      rmSync(part, { force: true });
      write("✗ 已配置更新公钥，但 latest.json 没有 signature——拒绝安装");
      return false;
    }
    const signed = verify(null, bytes, pubkey, Buffer.from(meta.signature, "base64"));
    if (!signed) {
      rmSync(part, { force: true });
      write("✗ 更新包签名校验失败");
      return false;
    }
    write("✓ 签名校验通过（Ed25519）");
  } else if (meta.signature !== undefined) {
    write("⚠ 未配置更新公钥（--pubkey / KCODE_UPDATE_PUBKEY），仅校验 sha256");
  }
  write("✓ 校验通过（size + sha256）");

  // 解包到 releases/<ver>（先解到临时目录，成功后原子换名——失败不留半装目录）
  const releases = join(home, "releases");
  const relName = `kcode-${meta.version}`;
  const target = join(releases, relName);
  const staging = join(releases, `${relName}.staging`);
  const previousTarget = currentTarget(releases);
  rmSync(staging, { recursive: true, force: true });
  try {
    validateTarEntries(part);
  } catch (err) {
    rmSync(part, { force: true });
    rmSync(staging, { recursive: true, force: true });
    write(`✗ ${err instanceof Error ? err.message : String(err)}`);
    return false;
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
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
  renameSync(staging, target);

  // 翻 current 指针（Windows Junction / POSIX 软链）——与 install.ps1/install.sh 同机制
  pointCurrent(releases, target);
  writePrevious(
    releases,
    previousTarget !== null && previousTarget !== target
      ? { target: previousTarget, version: currentVersion }
      : null,
  );
  write(`✓ 已安装 ${meta.version} → ${target}——重启 kcode 生效（原 ${currentVersion}）`);
  write("  （可用 kcode update --rollback 回滚到上一版）");
  return true;
}

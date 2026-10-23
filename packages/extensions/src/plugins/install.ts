import { cp, mkdir, readFile, rm, writeFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  PluginManifest,
  PluginSeed,
  type PluginManifest as PluginManifestType,
} from "@kcode/contracts";
import { parsePluginPermissions } from "./permissions.js";
import {
  PLUGIN_SIGNATURE_FILE,
  readPluginSignature,
  verifyPluginSignature,
  type PluginSignature,
  type TrustedPublisherKey,
} from "./signing.js";

export interface PluginInstallResult {
  name: string;
  version: string;
  /** 安装后的缓存目录 */
  installPath: string;
  /** 内容哈希（seed 锁定用） */
  hash: string;
  /** 同意摘要：安装时展示给用户确认的内容 */
  consentSummary: string;
}

export interface InstalledPlugin {
  manifest: PluginManifestType;
  installPath: string;
  seed: { hash: string; version: string; sig?: string };
}

/** 语义化版本比较（仅数字段；插件清单已限定 x.y.z） */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/** 3-16：同名插件只保留最高版本（缓存里残留的旧版本不参与装载） */
export function latestInstalledPlugins(installed: InstalledPlugin[]): InstalledPlugin[] {
  const best = new Map<string, InstalledPlugin>();
  for (const plugin of installed) {
    const current = best.get(plugin.manifest.name);
    if (current === undefined || compareVersions(plugin.manifest.version, current.manifest.version) > 0) {
      best.set(plugin.manifest.name, plugin);
    }
  }
  return [...best.values()];
}

/** seed 文件名（内容哈希锁定的锚点；加载期校验时排除自身） */
const SEED_FILE = ".kcode-seed.json";

/** 计算目录内容哈希（文件路径+内容的有序摘要，seed 锁定的基础） */
export async function hashPluginContent(dir: string, exclude: readonly string[] = []): Promise<string> {
  const ignored = new Set([SEED_FILE, PLUGIN_SIGNATURE_FILE, ...exclude]);
  const entries = (await collectFiles(dir)).filter((rel) => !ignored.has(rel));
  const hash = createHash("sha256");
  for (const relPath of entries.sort()) {
    const content = await readFile(join(dir, relPath));
    hash.update(relPath);
    hash.update(content);
  }
  return hash.digest("hex");
}

/** 兼容旧调用：只校验内容哈希（签名校验见 verifyInstalledPlugin）。 */
export async function verifyPluginSeed(installPath: string, expectedHash: string): Promise<boolean> {
  const actual = await hashPluginContent(installPath);
  return actual === expectedHash;
}

function parseSeedSignature(sig: string | undefined): { keyId: string; value: string } | null {
  if (sig === undefined || !sig.startsWith("ed25519:")) return null;
  const rest = sig.slice("ed25519:".length);
  const colon = rest.indexOf(":");
  if (colon <= 0) return null;
  return { keyId: rest.slice(0, colon), value: rest.slice(colon + 1) };
}

/**
 * 加载期验签：hash 锁内容，签名锁“发布者 + 内容”。
 * 未签名 seed 仅在非 strict 模式放行（本地开发）；签名存在但密钥未知/验签失败一律拒绝。
 */
export async function verifyInstalledPlugin(
  plugin: InstalledPlugin,
  opts: { trustedKeys: readonly TrustedPublisherKey[]; requireSignature?: boolean },
): Promise<{ ok: boolean; reason?: string; signedBy?: string }> {
  const hashOk = await verifyPluginSeed(plugin.installPath, plugin.seed.hash);
  if (!hashOk) return { ok: false, reason: "内容与安装时不一致" };
  const sig = parseSeedSignature(plugin.seed.sig);
  if (sig === null) {
    return opts.requireSignature === true
      ? { ok: false, reason: "插件未签名（当前要求签名）" }
      : { ok: true };
  }
  const trusted = opts.trustedKeys.find((key) => key.keyId === sig.keyId);
  if (trusted === undefined) return { ok: false, reason: `签名发布者 ${sig.keyId} 未受信任` };
  const signature: PluginSignature = {
    schema: "kcode.plugin.sig/1",
    algorithm: "ed25519",
    keyId: sig.keyId,
    signature: sig.value,
    payload: { name: plugin.manifest.name, version: plugin.manifest.version, hash: plugin.seed.hash },
  };
  if (!verifyPluginSignature(signature, trusted.publicKey)) {
    return { ok: false, reason: "签名校验失败" };
  }
  return { ok: true, signedBy: sig.keyId };
}

/** 递归收集目录下全部文件的相对路径 */
async function collectFiles(dir: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      result.push(...(await collectFiles(join(dir, entry.name), rel)));
    } else {
      result.push(rel);
    }
  }
  return result;
}

/** 读取并校验插件清单；不合法时给出可读错误 */
export async function readPluginManifest(sourceDir: string): Promise<PluginManifestType> {
  const raw = await readFile(join(sourceDir, ".kcode-plugin"), "utf8");
  const parsed = PluginManifest.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`插件清单不合法：${parsed.error.message}`);
  }
  return parsed.data;
}

/** 生成安装同意摘要：展示 hooks 命令、MCP 进程、技能列表——用户看到的就是安装后会自动运行的内容 */
export function buildConsentSummary(manifest: PluginManifestType): string {
  const lines: string[] = [`插件：${manifest.name} v${manifest.version}`];
  if (manifest.hooks.length > 0) {
    lines.push(`Hooks（将自动执行的命令）：`);
    for (const hook of manifest.hooks) {
      lines.push(`  [${hook.event}] ${hook.command}`);
    }
  }
  if (manifest.mcp.length > 0) {
    lines.push(`MCP 服务器（将启动的子进程）：`);
    for (const server of manifest.mcp) {
      lines.push(`  ${server.name}: ${server.command ?? server.url ?? "(未指定)"}`);
    }
  }
  if (manifest.skills.length > 0) {
    lines.push(`技能：${manifest.skills.join("、")}`);
  }
  if (manifest.commands.length > 0) {
    lines.push(`命令：${manifest.commands.join("、")}`);
  }
  if (manifest.agents.length > 0) {
    lines.push(`子代理：${manifest.agents.join("、")}`);
  }
  if (manifest.permissions.length > 0) {
    lines.push(`申请权限：${manifest.permissions.join("、")}`);
  }
  return lines.join("\n");
}

/**
 * 安装插件：从本地目录复制到版本化缓存，写入 seed（hash+版本锁定）。
 * 升级必须显式：同版本已存在时抛出，除非 force。
 */
export async function installPlugin(
  sourceDir: string,
  pluginsCacheDir: string,
  options: {
    force?: boolean;
    /** 4-08：true 时拒绝未签名插件（本地开发默认允许并在安装时提示） */
    requireSignature?: boolean;
    /** 已受信任的发布者公钥；签名插件必须命中 */
    trustedKeys?: readonly TrustedPublisherKey[];
  } = {},
): Promise<PluginInstallResult> {
  const manifest = await readPluginManifest(sourceDir);
  // 3-16：权限声明在安装期校验——只允许收紧（ask/deny），allow/未知格式直接拒装
  const permissions = parsePluginPermissions(manifest.permissions);
  if (permissions.errors.length > 0) {
    throw new Error(`插件权限声明不合法：${permissions.errors.join("；")}`);
  }
  const signature = await readPluginSignature(sourceDir);
  const sourceHash = await hashPluginContent(sourceDir);
  let signedBy: string | undefined;
  if (signature !== null) {
    if (
      signature.payload.name !== manifest.name ||
      signature.payload.version !== manifest.version ||
      signature.payload.hash !== sourceHash
    ) {
      throw new Error("插件签名与当前清单/内容不匹配（安装包可能被替换）");
    }
    const key = options.trustedKeys?.find((entry) => entry.keyId === signature.keyId);
    if (key === undefined) {
      throw new Error(
        `插件签名发布者 ${signature.keyId} 未受信任；先运行 kcode plugin trust <公钥.pem>，或安装时传 --trust-key <公钥.pem>`,
      );
    }
    if (!verifyPluginSignature(signature, key.publicKey)) {
      throw new Error("插件签名校验失败（安装包可能被篡改）");
    }
    signedBy = signature.keyId;
  } else if (options.requireSignature === true) {
    throw new Error("插件未签名；当前 --require-signature 要求所有插件必须签名");
  }
  const installPath = join(pluginsCacheDir, manifest.name, manifest.version);

  const existing = await stat(installPath).then(() => true).catch(() => false);
  if (existing && options.force !== true) {
    throw new Error(`${manifest.name} v${manifest.version} 已安装（升级需 --force）`);
  }
  // 只装最新版：存在更高版本时拒绝降级（--force 可显式降级覆盖）
  const versions = await readdir(join(pluginsCacheDir, manifest.name)).catch(() => [] as string[]);
  const newer = versions
    .filter((v) => v !== manifest.version && compareVersions(v, manifest.version) > 0)
    .sort(compareVersions)
    .at(-1);
  if (newer !== undefined && options.force !== true) {
    throw new Error(`${manifest.name} 已安装更新版本 v${newer}（只装最新版；--force 可降级覆盖）`);
  }
  if (existing) {
    await rm(installPath, { recursive: true, force: true });
  }

  await mkdir(installPath, { recursive: true });
  await cp(sourceDir, installPath, { recursive: true });

  const hash = await hashPluginContent(installPath);
  const seed: PluginSeed = {
    hash,
    marketplace: "local",
    plugin: manifest.name,
    version: manifest.version,
    sig: signedBy === undefined ? "local-install" : `ed25519:${signedBy}:${signature!.signature}`,
  };
  await writeFile(join(installPath, SEED_FILE), `${JSON.stringify(seed, null, 2)}\n`, "utf8");

  // 3-16：安装成功后清理同插件旧版本（best-effort；Windows 文件占用不阻断新版本可用）
  for (const version of versions) {
    if (version === manifest.version) {
      continue;
    }
    await rm(join(pluginsCacheDir, manifest.name, version), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  return {
    name: manifest.name,
    version: manifest.version,
    installPath,
    hash,
    consentSummary: buildConsentSummary(manifest),
  };
}

/** 卸载插件（按名+可选版本；不指定版本则删除全部版本） */
export async function uninstallPlugin(
  pluginsCacheDir: string,
  name: string,
  version?: string,
): Promise<string> {
  const target = version !== undefined ? join(pluginsCacheDir, name, version) : join(pluginsCacheDir, name);
  const exists = await stat(target).then(() => true).catch(() => false);
  if (!exists) {
    throw new Error(`未安装：${name}${version !== undefined ? `@${version}` : ""}`);
  }
  await rm(target, { recursive: true, force: true });
  return `已卸载 ${name}${version !== undefined ? `@${version}` : ""}`;
}

/** 列出已安装的全部插件（含 seed 校验） */
export async function listInstalledPlugins(pluginsCacheDir: string): Promise<InstalledPlugin[]> {
  const result: InstalledPlugin[] = [];
  let names;
  try {
    names = await readdir(pluginsCacheDir);
  } catch {
    return result;
  }
  for (const name of names) {
    const pluginDir = join(pluginsCacheDir, name);
    const versions = await readdir(pluginDir).catch(() => []);
    for (const version of versions) {
      const installPath = join(pluginDir, version);
      try {
        const manifest = await readPluginManifest(installPath);
        const seedRaw = await readFile(join(installPath, SEED_FILE), "utf8");
        const seed = JSON.parse(seedRaw) as { hash: string; version: string; sig?: string };
        result.push({ manifest, installPath, seed });
      } catch {
        // 跳过损坏的安装（清单或 seed 缺失）
      }
    }
  }
  return result;
}

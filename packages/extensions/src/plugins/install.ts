import { cp, mkdir, readFile, rm, writeFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  PluginManifest,
  PluginSeed,
  type PluginManifest as PluginManifestType,
} from "@kcode/contracts";

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
  seed: { hash: string; version: string };
}

/** 计算目录内容哈希（文件路径+内容的有序摘要，seed 锁定的基础） */
async function hashDirectory(dir: string): Promise<string> {
  const entries = await collectFiles(dir);
  const hash = createHash("sha256");
  for (const relPath of entries.sort()) {
    const content = await readFile(join(dir, relPath));
    hash.update(relPath);
    hash.update(content);
  }
  return hash.digest("hex");
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
  options: { force?: boolean } = {},
): Promise<PluginInstallResult> {
  const manifest = await readPluginManifest(sourceDir);
  const installPath = join(pluginsCacheDir, manifest.name, manifest.version);

  const existing = await stat(installPath).then(() => true).catch(() => false);
  if (existing && options.force !== true) {
    throw new Error(`${manifest.name} v${manifest.version} 已安装（升级需 --force）`);
  }
  if (existing) {
    await rm(installPath, { recursive: true, force: true });
  }

  await mkdir(installPath, { recursive: true });
  await cp(sourceDir, installPath, { recursive: true });

  const hash = await hashDirectory(installPath);
  const seed: PluginSeed = {
    hash,
    marketplace: "local",
    plugin: manifest.name,
    version: manifest.version,
    sig: "local-install",
  };
  await writeFile(join(installPath, ".kcode-seed.json"), `${JSON.stringify(seed, null, 2)}\n`, "utf8");

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
        const seedRaw = await readFile(join(installPath, ".kcode-seed.json"), "utf8");
        const seed = JSON.parse(seedRaw) as { hash: string; version: string };
        result.push({ manifest, installPath, seed });
      } catch {
        // 跳过损坏的安装（清单或 seed 缺失）
      }
    }
  }
  return result;
}

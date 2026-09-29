import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 插件启停状态（N3C-3）：宿主侧清单，独立于插件自带的 .kcode-plugin（.strict()）——
 * 停用是使用方的本地决策，不应要求插件作者在清单里声明字段。
 * 条目形如 `name`（停用该名全部版本）或 `name@version`（只停用该版本）。
 */
interface PluginsStateFile {
  version: 1;
  disabled: string[];
}

const STATE_FILE = "state.json";

/**
 * 读取停用清单；文件缺失或损坏按空处理——停用状态丢失只意味着"回到全启用"，
 * 可安全降级，不该让会话组装失败。
 */
export async function readDisabledPlugins(pluginsDir: string): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(join(pluginsDir, STATE_FILE), "utf8")) as PluginsStateFile;
    return Array.isArray(raw.disabled) ? raw.disabled : [];
  } catch {
    return [];
  }
}

/** 写回停用清单（tmp + rename 原子替换：进程中断不会留下半写的 state.json） */
async function writeDisabledPlugins(pluginsDir: string, disabled: string[]): Promise<void> {
  const target = join(pluginsDir, STATE_FILE);
  const tmp = `${target}.tmp`;
  const body: PluginsStateFile = { version: 1, disabled };
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

/**
 * 启停切换（幂等）：enable 时清掉该条目的两种形态（`name` 与全部 `name@*`），
 * disable 时仅在不存在时追加。
 */
export async function setPluginEnabled(pluginsDir: string, id: string, enabled: boolean): Promise<void> {
  const disabled = await readDisabledPlugins(pluginsDir);
  const at = id.indexOf("@");
  const next = enabled
    ? disabled.filter((d) => (at === -1 ? d !== id && !d.startsWith(`${id}@`) : d !== id))
    : disabled.includes(id)
      ? disabled
      : [...disabled, id];
  await writeDisabledPlugins(pluginsDir, next);
}

/**
 * 纯过滤：停用条目 `name` 命中该名全部版本、`name@version` 只命中精确版本。
 * 泛型只约束 manifest 形状，避免与 install.ts 的 InstalledPlugin 强耦合。
 */
export function filterEnabledPlugins<T extends { manifest: { name: string; version: string } }>(
  installed: T[],
  disabled: string[],
): T[] {
  if (disabled.length === 0) {
    return installed;
  }
  const set = new Set(disabled);
  return installed.filter(
    (p) => !set.has(p.manifest.name) && !set.has(`${p.manifest.name}@${p.manifest.version}`),
  );
}

import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UserConfigFile, type ProviderConfig } from "@kcode/contracts";

/** 用户级配置路径（host 侧唯一写入口；key 不在此文件） */
function userConfigPath(kcodeHomeDir: string): string {
  return join(kcodeHomeDir, "config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, { encoding: "utf8", mode: 0o600 });
  try {
    await copyFile(path, `${path}.bak`);
  } catch {
    // 首次保存无旧文件
  }
  try {
    await rename(tmp, path);
  } catch {
    await rm(path, { force: true });
    await rename(tmp, path);
  }
}

/**
 * D1-02：provider 级 merge 保存——保留 budget/未知根键/其他 provider，
 * 只覆盖本次 provider 与 models.default；写前用 UserConfigFile 整体校验。
 */
export async function saveUserProvider(
  kcodeHomeDir: string,
  input: { providerName: string; provider: ProviderConfig; model?: string },
): Promise<void> {
  const path = userConfigPath(kcodeHomeDir);
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("配置根节点不是对象");
    raw = parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`读取配置失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const models = isRecord(raw["models"]) ? raw["models"] : {};
  const providers = isRecord(models["providers"]) ? models["providers"] : {};
  providers[input.providerName] = input.provider;
  models["providers"] = providers;
  if (input.model !== undefined) models["default"] = input.model;
  raw["models"] = models;

  const checked = UserConfigFile.safeParse(raw);
  if (!checked.success) {
    throw new Error(`配置不合法：${checked.error.message.slice(0, 300)}`);
  }
  await writeAtomic(path, `${JSON.stringify(raw, null, 2)}\n`);
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { UserConfigFile, type LLMProvider, type UserModelsConfig } from "@kcode/contracts";
import { createProviderRouter, openKeychain, type KeychainStore, type ProviderRouter } from "@kcode/platform";

/**
 * 宿主侧装配（N3-1 注 E：key 只在 host——router/keychain 不出宿主进程）。
 * 复用 CLI 同源装配路径（loadUserConfig / openKeychain / createProviderRouter），
 * 但不复制 CLI 的 Runtime 接口——宿主自己就是 Runtime 的消费者。
 */

/** 读用户级模型配置；找不到返回空 providers（与 CLI bootstrap 同源语义） */
export async function loadUserModelsConfig(kcodeHomeDir: string): Promise<UserModelsConfig> {
  try {
    const raw = JSON.parse(await readFile(join(kcodeHomeDir, "config.json"), "utf8"));
    const parsed = UserConfigFile.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`配置不合法: ${parsed.error.message.slice(0, 200)}`);
    }
    return parsed.data.models ?? { providers: {} };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("配置不合法")) throw err;
    // 文件不存在或 JSON 损坏：空 providers（Ollama 等无 key 模型照常可用）
    return { providers: {} };
  }
}

/** 宿主 LLM 工厂：keychain 只在本进程解析，key 明文不出宿主（注 E） */
export function createHostLlmFactory(models: UserModelsConfig, kcodeHomeDir: string): (model: string) => Promise<LLMProvider> {
  let keychain: KeychainStore;
  try {
    keychain = openKeychain(join(kcodeHomeDir, "keys.json"));
  } catch {
    // 惰性降级：无 key 的 provider（Ollama）照常可用，首个需要 key 的调用会报可操作错误
    keychain = {
      async get() { throw new Error("keychain 不可用（未设口令且无 DPAPI）——宿主进程需 KCODE_KEYCHAIN_PASSPHRASE 或 Windows DPAPI"); },
      async set() { throw new Error("keychain 不可用"); },
      async delete() {},
      async list() { return []; },
    };
  }
  const router: ProviderRouter = createProviderRouter(models, keychain);
  return (model) => router.resolve(model);
}

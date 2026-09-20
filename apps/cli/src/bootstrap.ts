import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { UserConfigFile, type UserModelsConfig } from "@kcode/contracts";
import {
  EncryptedFileKeychain,
  createProviderRouter,
  type KeychainStore,
  type ProviderRouter,
} from "@kcode/platform";

export function kcodeHome(): string {
  return join(homedir(), ".kcode");
}

export interface Runtime {
  models: UserModelsConfig;
  keychain: KeychainStore;
  router: ProviderRouter;
}

/** 读用户级配置（providers 只允许在这一层，§5.7 第一层防御） */
export async function loadUserConfig(
  path = join(kcodeHome(), "config.json"),
): Promise<UserModelsConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `未找到用户级配置 ${path}——请按 README「试用」一节创建（providers 只存在于用户级）`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`配置不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = UserConfigFile.safeParse(json);
  if (!parsed.success) {
    throw new Error(`配置不合法: ${parsed.error.message}`);
  }
  return parsed.data.models ?? { providers: {} };
}

/**
 * 组装运行时：配置 → keychain → providers 路由。
 * 口令缺失时给"惰性"keychain——只有真正用到 key 的 provider 才会报错（本地 Ollama 无 key 可用）。
 */
export async function bootstrap(options: { fetch?: typeof fetch } = {}): Promise<Runtime> {
  const models = await loadUserConfig();
  const passphrase = process.env["KCODE_KEYCHAIN_PASSPHRASE"];
  const keychain: KeychainStore =
    passphrase !== undefined && passphrase !== ""
      ? EncryptedFileKeychain.fromEnv(join(kcodeHome(), "keys.json"))
      : {
          async get() {
            throw new Error(
              "此 provider 需要 key：请设置 KCODE_KEYCHAIN_PASSPHRASE 并用 kcode key add 录入（§5.7）",
            );
          },
          async set() {
            throw new Error("录入 key 需要设置 KCODE_KEYCHAIN_PASSPHRASE");
          },
          async delete() {
            throw new Error("管理 key 需要设置 KCODE_KEYCHAIN_PASSPHRASE");
          },
          async list() {
            return [];
          },
        };
  const router = createProviderRouter(models, keychain, options);
  return { models, keychain, router };
}

/** 必须显式设置 default（模型 id 因厂商而异，不猜测） */
export function requireDefaultModelRef(models: UserModelsConfig): string {
  if (models.default !== undefined && models.default !== "") {
    return models.default;
  }
  throw new Error(
    "请在 ~/.kcode/config.json 设置 models.default（如 \"deepseek/deepseek-chat\" 或 \"ollama/qwen2.5-coder\"）",
  );
}

/** 写用户级配置（/login 向导用；providers 只存在于这一层，§5.7） */
export async function saveUserModelsConfig(
  models: UserModelsConfig,
  path = join(kcodeHome(), "config.json"),
): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ models }, null, 2)}\n`, "utf8");
}

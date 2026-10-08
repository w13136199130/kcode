import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { UserConfigFile, isModelRef, type IPlatformService, type UserModelsConfig } from "@kcode/contracts";
import {
  createPlatformService,
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
  /** 平台服务（N2-1）：UI 经此访问 keychain/平台能力，不直接依赖 platform 包 */
  platform: IPlatformService;
  /** kcode 主目录（~/.kcode；本地会话组装与 JSONL 落盘的基准） */
  kcodeHomeDir: string;
  /** 会话 token 预算（N3I-8）：用户级 config.json budget.maxSessionTokens，env KCODE_BUDGET_TOKENS 覆盖 */
  sessionBudgetTokens?: number;
}

/** CLI 的平台服务装配（N2-1 唯一 import platform 的 UI 侧入口；key 子命令在 bootstrap 前也用它） */
export function createCliPlatformService(): IPlatformService {
  return createPlatformService({
    keysFile: join(kcodeHome(), "keys.json"),
    dpapiKeysFile: join(kcodeHome(), "keys.dpapi.json"),
  });
}

/** 读用户级配置（providers 只允许在这一层，§5.7 第一层防御） */
/**
 * 配置覆盖层（N3E-3，三层浅合并——对标 zcode 五级裁剪）：
 * 用户级（providers 唯一来源，安全边界不动）→ Project `.kcode/config.json`（仅 default 模型）
 * → Env 白名单 KCODE_DEFAULT_MODEL。深合并不做（zcode 实测也仅一层浅 spread）。
 */
export async function loadUserConfig(
  path = join(kcodeHome(), "config.json"),
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<UserModelsConfig> {
  const env = opts.env ?? process.env;
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
  const models = parsed.data.models ?? { providers: {} };
  // Project 层：仅接受 default 覆盖；providers/密钥字段一律忽略（防项目投毒端点）
  if (opts.cwd !== undefined) {
    try {
      const projectRaw = JSON.parse(await readFile(join(opts.cwd, ".kcode", "config.json"), "utf8")) as {
        models?: { default?: unknown };
      };
      const projectDefault = projectRaw.models?.default;
      if (typeof projectDefault === "string" && projectDefault !== "") {
        models.default = projectDefault;
      }
    } catch {
      // 项目级配置缺失/损坏按无覆盖处理
    }
  }
  // Env 白名单（逐项硬编码，不开放通用语法——对标 zcode env-config.adapter 的收窄原则）
  const envModel = env["KCODE_DEFAULT_MODEL"];
  if (envModel !== undefined && envModel !== "") {
    models.default = envModel;
  }
  return models;
}

/**
 * 组装运行时：配置 → keychain → providers 路由。
 * 口令缺失时给"惰性"keychain——只有真正用到 key 的 provider 才会报错（本地 Ollama 无 key 可用）。
 */
export async function bootstrap(options: { fetch?: typeof fetch } = {}): Promise<Runtime> {
  const models = await loadUserConfig();
  const platform = createCliPlatformService();
  let keychain: KeychainStore;
  try {
    // 口令 > Windows DPAPI（B5 免口令）；两者皆不可用时惰性降级——无 key 的 provider（Ollama）照常可用
    keychain = platform.openDefaultKeychain();
  } catch {
    keychain = {
          async get() {
            throw new Error(
              "此 provider 需要 key：Windows 免口令直接 kcode key add 录入；其他平台设置 KCODE_KEYCHAIN_PASSPHRASE 后录入（§5.7）",
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
  }
  const router = createProviderRouter(models, keychain, options);
  return { models, keychain, router, platform, kcodeHomeDir: kcodeHome(), sessionBudgetTokens: await loadSessionBudgetTokens() };
}

/**
 * 会话 token 预算（N3I-8）：读用户级 config.json 的 budget.maxSessionTokens，
 * env KCODE_BUDGET_TOKENS（正整数）覆盖（白名单同 KCODE_DEFAULT_MODEL 收窄原则；
 * 缺失/文件不存在/值非法 → undefined = 预算关）。
 */
export async function loadSessionBudgetTokens(
  path = join(kcodeHome(), "config.json"),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | undefined> {
  const envVal = env["KCODE_BUDGET_TOKENS"];
  if (envVal !== undefined && envVal !== "" && /^\d+$/.test(envVal) && Number(envVal) > 0) {
    return Number(envVal);
  }
  try {
    const parsed = UserConfigFile.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (parsed.success) {
      return parsed.data.budget?.maxSessionTokens;
    }
  } catch {
    // 配置缺失/损坏：loadUserConfig 主路径已报错，这里静默按预算关
  }
  return undefined;
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

/**
 * CLI --model 覆盖（N3F-5）：N3E-3 三层之上的第四层，单次运行优先级最高——
 * 给了 --model 即不需要 default 存在。格式与 provider 存在性当场校验（fail-fast），
 * 未知 provider 列出可用清单；裸模型名沿用 default 的 provider（与路由解析同规则）。
 */
export function resolveModelOverride(models: UserModelsConfig, value: string): string {
  if (!isModelRef(value)) {
    throw new Error(`--model 格式不合法：${value}（应为 provider/model，如 deepseek/deepseek-chat）`);
  }
  let providerName: string;
  if (value.includes("/")) {
    providerName = value.split("/")[0]!;
  } else {
    const fallback = models.default;
    if (fallback === undefined || fallback === "" || !fallback.includes("/")) {
      throw new Error(`--model 裸模型名需要 default 配置了 provider 前缀才能解析——请用 provider/model 形式`);
    }
    providerName = fallback.split("/")[0]!;
  }
  if (models.providers[providerName] === undefined) {
    const available = Object.keys(models.providers).join("、") || "（无——先在 ~/.kcode/config.json 配置 providers）";
    throw new Error(`--model 的 provider "${providerName}" 未配置——可用：${available}`);
  }
  return value;
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

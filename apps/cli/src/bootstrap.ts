import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ProjectConfigFile,
  UserConfigFile,
  isModelRef,
  type IPlatformService,
  type PermissionMode,
  type ProviderConfig,
  type UserModelsConfig,
} from "@kcode/contracts";
import {
  createPlatformService,
  createProviderRouter,
  type KeychainStore,
  type ProviderRouter,
} from "@kcode/platform";

export function kcodeHome(): string {
  // 2-06：CI/多 profile 隔离；空值按默认 ~/.kcode
  const override = process.env["KCODE_HOME"];
  return override !== undefined && override !== "" ? override : join(homedir(), ".kcode");
}

export interface Runtime {
  models: UserModelsConfig;
  keychain: KeychainStore;
  router: ProviderRouter;
  /** 平台服务（N2-1）：UI 经此访问 keychain/平台能力，不直接依赖 platform 包 */
  platform: IPlatformService;
  /** kcode 主目录（~/.kcode；本地会话组装与 JSONL 落盘的基准） */
  kcodeHomeDir: string;
  /** 当前用户级配置文件（--settings 可覆盖；/login 写回同一路径） */
  configPath: string;
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
  } catch (err) {
    // 2-01：首次启动/删配置后仍要能进 TUI，用空 providers 起步；格式损坏仍要 fail-fast
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { providers: {} };
    }
    throw new Error(
      `读取用户级配置失败 ${path}：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`配置不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  warnUnknownConfigKeys(json);
  const parsed = UserConfigFile.safeParse(json);
  if (!parsed.success) {
    throw new Error(`配置不合法: ${parsed.error.message}`);
  }
  const models = parsed.data.models ?? { providers: {} };
  // Project 层：只接受 default（providers 在 schema 层不可表达）；mode 由 loadProjectConfig 单独消费
  if (opts.cwd !== undefined) {
    const project = await loadProjectConfig(opts.cwd);
    if (project.default !== undefined && project.default !== "") {
      models.default = project.default;
    }
  }
  // Env 白名单（逐项硬编码，不开放通用语法——对标 zcode env-config.adapter 的收窄原则）
  const envModel = env["KCODE_DEFAULT_MODEL"];
  if (envModel !== undefined && envModel !== "") {
    models.default = envModel;
  }
  return models;
}

/** 2-06：未知键告警但不阻断（strict 会因手写注释/未来字段直接锁死启动） */
function warnUnknownConfigKeys(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const root = raw as Record<string, unknown>;
  const unknownRoot = Object.keys(root).filter((k) => k !== "models" && k !== "budget");
  const modelObj = typeof root.models === "object" && root.models !== null ? (root.models as Record<string, unknown>) : null;
  const unknownModel = modelObj === null ? [] : Object.keys(modelObj).filter((k) => k !== "default" && k !== "providers");
  const all = [...unknownRoot, ...unknownModel.map((k) => `models.${k}`)];
  if (all.length > 0) {
    process.stderr.write(`⚠ 忽略未知配置键：${all.join("、")}（配置仍会加载）\n`);
  }
}

/** 项目级配置（N3E-3 + 2-06）：只允许 default 与 mode；缺失/损坏按无覆盖并告警 */
export async function loadProjectConfig(cwd = process.cwd()): Promise<{
  default?: string;
  mode?: PermissionMode;
}> {
  try {
    const raw = JSON.parse(await readFile(join(cwd, ".kcode", "config.json"), "utf8"));
    const parsed = ProjectConfigFile.safeParse(raw);
    if (parsed.success) {
      return {
        ...(parsed.data.models?.default !== undefined ? { default: parsed.data.models.default } : {}),
        ...(parsed.data.mode !== undefined ? { mode: parsed.data.mode } : {}),
      };
    }
    // 旧行为兼容/防投毒：项目里混入 providers 时整份 strict 会失败，
    // 但仍应让合法的 default 生效；providers 一律无视。
    const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const models = typeof obj.models === "object" && obj.models !== null ? (obj.models as Record<string, unknown>) : {};
    const fallbackDefault = typeof models.default === "string" && isModelRef(models.default) ? models.default : undefined;
    const modes = ["plan", "default", "acceptEdits", "fullAccess"] as const;
    const fallbackMode = modes.find((m) => m === obj.mode);
    process.stderr.write(`⚠ 项目配置含未知键，已忽略：${parsed.error.message}\n`);
    return {
      ...(fallbackDefault !== undefined ? { default: fallbackDefault } : {}),
      ...(fallbackMode !== undefined ? { mode: fallbackMode } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * 组装运行时：配置 → keychain → providers 路由。
 * 口令缺失时给"惰性"keychain——只有真正用到 key 的 provider 才会报错（本地 Ollama 无 key 可用）。
 */
export async function bootstrap(
  options: { fetch?: typeof fetch; settingsPath?: string } = {},
): Promise<Runtime> {
  const configPath = options.settingsPath ?? join(kcodeHome(), "config.json");
  const models = await loadUserConfig(configPath);
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
  return {
    models,
    keychain,
    router,
    platform,
    kcodeHomeDir: kcodeHome(),
    configPath,
    sessionBudgetTokens: await loadSessionBudgetTokens(configPath),
  };
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

/** kcode init：只创建最小骨架，不猜 provider/model；下一步交给 /login */
export async function initUserConfig(
  path = join(kcodeHome(), "config.json"),
): Promise<{ created: boolean }> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify({ models: { providers: {} } }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return { created: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return { created: false };
    throw err;
  }
}

/**
 * 2-03：/login 只合并当前 provider，保留其他 provider 与 budget 等根字段。
 * 写入顺序：临时文件 → 备份旧文件 → rename 覆盖；崩溃时旧配置仍在。
 */
export async function saveProviderConfig(input: {
  providerName: string;
  provider: ProviderConfig;
  defaultModel: string;
  path?: string;
}): Promise<void> {
  const { copyFile, mkdir, rename, rm, writeFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const path = input.path ?? join(kcodeHome(), "config.json");

  let root: unknown = {};
  try {
    root = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`读取现有配置失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const parsed = UserConfigFile.safeParse(root);
  if (!parsed.success) {
    // 不静默覆盖损坏配置——里面可能有用户手写的 provider/budget
    throw new Error(`现有配置不合法，拒绝覆盖：${parsed.error.message}`);
  }
  const models = parsed.data.models ?? { providers: {} };
  const rawRoot = typeof root === "object" && root !== null ? (root as Record<string, unknown>) : {};
  const next = {
    // 保留未知根键（2-06 只告警不阻断；保存时不能悄悄删掉用户字段）
    ...rawRoot,
    ...parsed.data,
    models: {
      ...models,
      default: input.defaultModel,
      providers: { ...models.providers, [input.providerName]: input.provider },
    },
  };

  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  try {
    await copyFile(path, `${path}.bak`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    // Windows 某些文件系统不覆盖目标：退化为删旧再 rename（备份已存在）
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM") throw err;
    await rm(path, { force: true });
    await rename(tmp, path);
  }
}



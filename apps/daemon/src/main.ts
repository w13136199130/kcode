import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { UserConfigFile, type LLMProvider } from "@kcode/contracts";
import { createProviderRouter, EncryptedFileKeychain, type KeychainStore } from "@kcode/platform";
import { startDaemon } from "./server.js";

/** daemon 版本号（与仓库版本保持同步） */
const DAEMON_VERSION = "0.1.0";

/** kcode 主目录（~/.kcode） */
export function defaultKcodeHome(): string {
  return join(homedir(), ".kcode");
}

/** 本地通道地址：Windows 用命名管道，其余用 Unix socket */
export function daemonPipePath(): string {
  if (process.platform === "win32") {
    const user = process.env["USERNAME"] ?? process.env["USER"] ?? "default";
    return `\\\\.\\pipe\\kcode-${Buffer.from(user).toString("hex").slice(0, 12)}`;
  }
  return join(defaultKcodeHome(), "daemon.sock");
}

/** 无口令时的惰性 keychain：仅在真正需要 key 的模型上报错 */
const lazyKeychain: KeychainStore = {
  async get() {
    throw new Error("此模型需要 API key：请设置 KCODE_KEYCHAIN_PASSPHRASE 并录入 key");
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

/** 组装模型工厂：读用户配置 → keychain → providers 路由（含受众绑定校验） */
async function createLlmFactory(kcodeHomeDir: string): Promise<(model: string) => Promise<LLMProvider>> {
  const raw = await readFile(join(kcodeHomeDir, "config.json"), "utf8");
  const parsed = UserConfigFile.safeParse(JSON.parse(raw));
  if (!parsed.success || parsed.data.models === undefined) {
    throw new Error("用户配置缺失或不合法（~/.kcode/config.json）");
  }
  const passphrase = process.env["KCODE_KEYCHAIN_PASSPHRASE"];
  const keychain: KeychainStore =
    passphrase !== undefined && passphrase !== ""
      ? EncryptedFileKeychain.fromEnv(join(kcodeHomeDir, "keys.json"))
      : lazyKeychain;
  const router = createProviderRouter(parsed.data.models, keychain);
  return (model: string) => router.resolve(model);
}

async function main(): Promise<void> {
  const kcodeHomeDir = defaultKcodeHome();
  const pipePath = daemonPipePath();
  const token = randomBytes(32).toString("hex");
  // token 落盘供 CLI attach（0600 语义由平台文件系统保证；spawn 直传形态留待打包分发）
  const { mkdir } = await import("node:fs/promises");
  await mkdir(kcodeHomeDir, { recursive: true });
  await writeFile(join(kcodeHomeDir, "daemon.token"), token, "utf8");

  const llmFactory = await createLlmFactory(kcodeHomeDir);
  const handle = await startDaemon({
    pipePath,
    token,
    kcodeHomeDir,
    llmFactory,
    daemonVersion: DAEMON_VERSION,
  });
  process.stderr.write(`kcode daemon 已就绪：${handle.pipePath}\n`);
  // 常驻：连接由 server 管理，进程不主动退出
  process.on("SIGINT", () => {
    void handle.close().then(() => {
      process.exit(0);
    });
  });
  process.on("SIGTERM", () => {
    void handle.close().then(() => {
      process.exit(0);
    });
  });
}

main().catch((err) => {
  process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

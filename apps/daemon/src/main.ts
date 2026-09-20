import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { appendFileSync, rmSync } from "node:fs";
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

/** 组装模型工厂与模型清单：读用户配置 → keychain → providers 路由（含受众绑定校验） */
async function createLlmFactory(
  kcodeHomeDir: string,
): Promise<{
  llmFactory: (model: string) => Promise<LLMProvider>;
  modelsInfo: () => { default?: string; providers: string[] };
}> {
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
  const models = parsed.data.models;
  return {
    llmFactory: (model: string) => router.resolve(model),
    modelsInfo: () => ({
      ...(models.default !== undefined ? { default: models.default } : {}),
      providers: Object.keys(models.providers),
    }),
  };
}

/** 守护日志：常驻进程的 stderr 与崩溃现场落盘（界面看不到 daemon，无日志无法排查） */
const LOG_PATH = join(defaultKcodeHome(), "daemon.log");

function log(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  try {
    appendFileSync(LOG_PATH, stamped, "utf8");
  } catch {
    // 日志失败静默（不能因日志把主流程打挂）
  }
  process.stderr.write(stamped);
}

async function main(): Promise<void> {
  const kcodeHomeDir = defaultKcodeHome();
  const pipePath = daemonPipePath();
  const token = randomBytes(32).toString("hex");
  // token/pid 落盘供 CLI attach 与版本错配时定位旧进程（0600 语义由平台文件系统保证）
  const { mkdir } = await import("node:fs/promises");
  await mkdir(kcodeHomeDir, { recursive: true });
  await writeFile(join(kcodeHomeDir, "daemon.token"), token, "utf8");
  await writeFile(join(kcodeHomeDir, "daemon.pid"), `${process.pid}\n`, "utf8");

  const { llmFactory, modelsInfo } = await createLlmFactory(kcodeHomeDir);
  const handle = await startDaemon({
    pipePath,
    token,
    kcodeHomeDir,
    llmFactory,
    modelsInfo,
    daemonVersion: DAEMON_VERSION,
  });
  process.stderr.write(`kcode daemon 已就绪：${handle.pipePath}\n`);
  // 常驻：连接由 server 管理，进程不主动退出
  const cleanExit = (): void => {
    void handle.close().then(() => {
      try {
        rmSync(join(kcodeHomeDir, "daemon.pid"), { force: true });
      } catch {
        // pidfile 清理失败不影响退出
      }
      process.exit(0);
    });
  };
  process.on("SIGINT", cleanExit);
  process.on("SIGTERM", cleanExit);
}

// 常驻进程的兜底：未捕获异常记日志后继续存活（一次异常不该杀死所有会话）
process.on("uncaughtException", (err) => {
  log(`uncaughtException: ${err.stack ?? String(err)}`);
});
process.on("unhandledRejection", (reason) => {
  log(
    `unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`,
  );
});

main().catch((err) => {
  log(`启动失败: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});

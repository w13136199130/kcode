import type { KeychainEntry } from "./provider.js";

/**
 * 平台服务端口（N2-1 多端地基）：前端/UI 只经此接口访问平台能力，
 * 禁止直接依赖平台实现包——装配点唯一（宿主 bootstrap / N3 Web 入口）。
 * 对标 ZCode platform.ts，字段按 kcode 实际使用面裁剪：凭证存储 + 平台事实。
 */

/** 凭证存储操作端口：实现为加密文件 / Windows DPAPI，由 openXxx 按环境选择 */
interface IKeychainStore {
  get(ref: string): Promise<KeychainEntry | null>;
  set(ref: string, key: string, audiences: string[]): Promise<void>;
  delete(ref: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface IPlatformService {
  /** 本平台是否支持系统级免口令加密存储（Windows DPAPI）——UI 据此提示"口令可留空" */
  readonly secureStorageAvailable: boolean;
  /** 环境感知默认存储：口令 env > DPAPI；均不可用时抛错（调用方决定是否惰性降级） */
  openDefaultKeychain(): IKeychainStore;
  /** 指定口令的加密文件存储（/login 向导录入 key 用） */
  openPassphraseKeychain(passphrase: string): IKeychainStore;
  /** 系统级免口令存储；不支持的平台抛错（语义等价"口令不能为空"） */
  openSecureKeychain(): IKeychainStore;
  /** 当前环境口令能否解开既有 keys.json（启动预警校验；仅口令式存储适用） */
  verifyEnvPassphrase(): Promise<boolean>;
}

/**
 * 前端侧平台端口（N3-2 注 E：按进程拆两半）：
 * - secureStorageAvailable + probe + saveKey——仅此三项，**不含** open*Keychain（key 明文不出宿主）；
 * - 宿主进程（apps/host）持有完整 IPlatformService 实现；
 * - 前端（CLI/Web/Desktop 渲染层）只拿本接口——单进程模式下由本地适配器实现，
 *   进程边界后由 RPC 代理实现（形态不变，前端组件不感知）。
 */
export interface PlatformClientPort {
  /** 本平台是否支持免口令系统级加密存储（Windows DPAPI） */
  readonly secureStorageAvailable: boolean;
  /** 探测某 key 引用是否已录入且可用（不返回 key 本身） */
  probe(ref: string): Promise<boolean>;
  /** 录入 key（passphrase 指定时用口令加密，否则走系统存储；两者皆不可用时抛错） */
  saveKey(ref: string, key: string, audiences: string[], passphrase?: string): Promise<void>;
}

/**
 * 将宿主侧完整平台服务适配为前端端口（单进程模式下的本地实现）。
 * 进程边界后换 RPC 代理（probe → platform/probe，saveKey → platform/saveKey），前端组件不改。
 */
export function platformClientAdapter(host: IPlatformService): PlatformClientPort {
  return {
    secureStorageAvailable: host.secureStorageAvailable,
    probe: async (ref) => {
      try {
        return (await host.openDefaultKeychain().get(ref)) !== null;
      } catch {
        return false;
      }
    },
    saveKey: async (ref, key, audiences, passphrase) => {
      if (passphrase !== undefined && passphrase !== "") {
        await host.openPassphraseKeychain(passphrase).set(ref, key, audiences);
        return;
      }
      await host.openSecureKeychain().set(ref, key, audiences);
    },
  };
}

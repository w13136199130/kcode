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

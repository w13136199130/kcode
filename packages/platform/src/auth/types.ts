import type { KeychainEntry } from "@kcode/contracts";

/** 凭证存取端口：CLI 组装时注入；实现仅 platform 与测试可替换（独立文件防 dpapi ↔ keychain 环） */
export interface KeychainStore {
  get(ref: string): Promise<KeychainEntry | null>;
  set(ref: string, key: string, audiences: string[]): Promise<void>;
  delete(ref: string): Promise<void>;
  list(): Promise<string[]>;
}

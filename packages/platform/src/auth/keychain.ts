import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { KeychainEntry } from "@kcode/contracts";

/** 凭证存取端口：daemon 组装时注入；实现仅 platform 与测试可替换 */
export interface KeychainStore {
  get(ref: string): Promise<KeychainEntry | null>;
  set(ref: string, key: string, audiences: string[]): Promise<void>;
  delete(ref: string): Promise<void>;
  list(): Promise<string[]>;
}

/**
 * P1 加密文件降级（§5.7）：passphrase（PBKDF2 100k 轮）→ AES-256-GCM。
 * 禁止自制"机器 ID 派生密钥"的假保护——口令来自环境变量，缺省时显式报错。
 * P3 接原生：Windows DPAPI / macOS Keychain，接口不变。
 */
export class EncryptedFileKeychain implements KeychainStore {
  #cache: Map<string, KeychainEntry> | null = null;

  constructor(
    private readonly filePath: string,
    private readonly passphrase: string,
  ) {}

  static fromEnv(filePath: string): EncryptedFileKeychain {
    const passphrase = process.env["KCODE_KEYCHAIN_PASSPHRASE"];
    if (passphrase === undefined || passphrase === "") {
      throw new Error(
        "未设置 KCODE_KEYCHAIN_PASSPHRASE：P1 降级要求口令派生加密密钥（P3 接原生 keychain，§5.7）",
      );
    }
    return new EncryptedFileKeychain(filePath, passphrase);
  }

  async get(ref: string): Promise<KeychainEntry | null> {
    return (await this.#load()).get(ref) ?? null;
  }

  async set(ref: string, key: string, audiences: string[]): Promise<void> {
    const map = await this.#load();
    map.set(ref, { ref, key, audiences });
    await this.#flush(map);
  }

  async delete(ref: string): Promise<void> {
    const map = await this.#load();
    map.delete(ref);
    await this.#flush(map);
  }

  async list(): Promise<string[]> {
    return [...(await this.#load()).keys()];
  }

  async #load(): Promise<Map<string, KeychainEntry>> {
    if (this.#cache !== null) return this.#cache;
    let raw = "";
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      // 文件不存在视为空 keychain
    }
    const map = new Map<string, KeychainEntry>();
    if (raw.trim() !== "") {
      const plain = decrypt(raw, this.passphrase);
      for (const entry of JSON.parse(plain) as KeychainEntry[]) {
        map.set(entry.ref, entry);
      }
    }
    this.#cache = map;
    return map;
  }

  async #flush(map: Map<string, KeychainEntry>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, encrypt(JSON.stringify([...map.values()]), this.passphrase), "utf8");
    this.#cache = map;
  }
}

interface Envelope {
  v: 1;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, 100_000, 32, "sha256");
}

function encrypt(plain: string, passphrase: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const envelope: Envelope = {
    v: 1,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return JSON.stringify(envelope);
}

function decrypt(payload: string, passphrase: string): string {
  const envelope = JSON.parse(payload) as Envelope;
  const salt = Buffer.from(envelope.salt, "base64");
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const data = Buffer.from(envelope.data, "base64");
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("keychain 解密失败：口令错误或文件损坏");
  }
}

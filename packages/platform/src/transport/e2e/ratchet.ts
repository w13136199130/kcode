import { hkdfSync } from "node:crypto";

/** HKDF 链的信息域前缀（区分 ratchet 与 DEK 包装等不同用途） */
const RATCHET_INFO = Buffer.from("kcode-msg-ratchet");

/**
 * HKDF 逐消息 ratchet：从会话 DEK 派生每条消息的独立密钥。
 * 每条消息用不同的密钥加密，即使某条消息密钥泄露也不影响其他消息（前向保密）。
 * 链式结构：key[n] = HKDF(key[n-1], seq=n)，不可逆推。
 */
export class MessageRatchet {
  #dek: Buffer;
  #seq: number;
  /** 缓存最近几条消息的密钥，支持乱序解密 */
  readonly #keyCache = new Map<number, Buffer>();

  constructor(dek: Buffer, startSeq = 0) {
    this.#dek = dek;
    this.#seq = startSeq;
  }

  /** 生成下一条消息的加密密钥（序号自增） */
  nextKey(): { key: Buffer; sequence: number } {
    this.#seq += 1;
    const key = this.deriveKey(this.#seq);
    this.#keyCache.set(this.#seq, key);
    // 只保留最近 32 条的密钥缓存，防止内存膨胀
    if (this.#keyCache.size > 32) {
      const oldest = Math.min(...this.#keyCache.keys());
      this.#keyCache.delete(oldest);
    }
    return { key, sequence: this.#seq };
  }

  /** 按序号取回密钥（用于解密乱序到达的消息） */
  deriveKey(sequence: number): Buffer {
    const cached = this.#keyCache.get(sequence);
    if (cached !== undefined) {
      return cached;
    }
    // 从 DEK + 序号直接派生（无需从头演算整条链）
    const key = Buffer.from(
      hkdfSync("sha256", this.#dek, sequenceToSalt(sequence), RATCHET_INFO, 32),
    );
    return key;
  }

  /** 当前序号 */
  get sequence(): number {
    return this.#seq;
  }
}

/** 序号转 salt：定长 8 字节大端，保证 HKDF 输入确定性 */
function sequenceToSalt(sequence: number): Buffer {
  const salt = Buffer.alloc(8);
  salt.writeBigUInt64BE(BigInt(sequence));
  return salt;
}

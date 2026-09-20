import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { MessageRatchet } from "./ratchet.js";
import {
  generateDek,
  openMessage,
  sealMessage,
  wrapDekForDevice,
  unwrapDek,
  type SealedEnvelope,
} from "./envelope.js";
import type { DeviceKeyPair } from "./device-key.js";

/**
 * 会话加密管理：一个会话对应一把 DEK + 一条 ratchet 链。
 * 发送方加密消息，接收方用同一把 DEK 的 ratchet 解密。
 * epoch 轮换时生成新 DEK 并重新分发给所有授权设备。
 */
export class SessionCrypto {
  #dek: Buffer;
  #ratchet: MessageRatchet;
  readonly sessionId: string;
  #epoch: number;

  constructor(sessionId: string, dek?: Buffer, epoch = 0) {
    this.sessionId = sessionId;
    this.#dek = dek ?? generateDek();
    this.#ratchet = new MessageRatchet(this.#dek);
    this.#epoch = epoch;
  }

  /** 当前 epoch 编号 */
  get epoch(): number {
    return this.#epoch;
  }

  /** 加密一条消息：ratchet 派生密钥 + AES-GCM */
  encrypt(plaintext: string | Buffer): {
    ciphertext: Buffer;
    nonce: Buffer;
    tag: Buffer;
    sequence: number;
    epoch: number;
  } {
    const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
    const { key, sequence } = this.#ratchet.nextKey();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    return {
      ciphertext,
      nonce,
      tag: cipher.getAuthTag(),
      sequence,
      epoch: this.#epoch,
    };
  }

  /** 解密一条消息：按序号派生密钥 + AES-GCM */
  decrypt(encrypted: {
    ciphertext: Buffer;
    nonce: Buffer;
    tag: Buffer;
    sequence: number;
  }): Buffer {
    const key = this.#ratchet.deriveKey(encrypted.sequence);
    const decipher = createDecipheriv("aes-256-gcm", key, encrypted.nonce);
    decipher.setAuthTag(encrypted.tag);
    return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
  }

  /**
   * epoch 轮换：生成新 DEK + 新 ratchet。
   * 调用方负责把返回的信封分发给所有授权设备。
   * 被撤销的设备不再收到新信封——旧 DEK 解不开新 epoch 的消息。
   */
  rotate(authorizedDeviceKeys: Buffer[]): {
    newEpoch: number;
    envelopes: Array<{ devicePublicKey: Buffer } & ReturnType<typeof wrapDekForDevice>>;
  } {
    this.#epoch += 1;
    this.#dek = generateDek();
    this.#ratchet = new MessageRatchet(this.#dek);
    const envelopes = authorizedDeviceKeys.map((deviceKey) => ({
      devicePublicKey: deviceKey,
      ...wrapDekForDevice(this.#dek, deviceKey),
    }));
    return { newEpoch: this.#epoch, envelopes };
  }

  /** 应用 epoch 轮换：设备收到新信封后解出 DEK 并切换 */
  applyRotation(
    devicePrivateKey: Buffer,
    envelope: { ephemeralPublicKey: Buffer; wrappedDek: Buffer; dekNonce: Buffer; dekTag: Buffer },
    newEpoch: number,
  ): void {
    this.#dek = unwrapDek(
      devicePrivateKey,
      envelope.ephemeralPublicKey,
      envelope.wrappedDek,
      envelope.dekNonce,
      envelope.dekTag,
    );
    this.#ratchet = new MessageRatchet(this.#dek);
    this.#epoch = newEpoch;
  }
}

/**
 * 端到端加密的一次完整往返（集成测试用）：
 * 设备 A 加密 → relay 只见密文 → 设备 B 解密。
 */
export function e2eRoundTrip(
  senderKeys: DeviceKeyPair,
  recipientKeys: DeviceKeyPair,
  message: string,
): { sealed: SealedEnvelope; decrypted: string } {
  const { envelope } = sealMessage(
    Buffer.from(message, "utf8"),
    recipientKeys.encryption.publicKey,
  );
  const decrypted = openMessage(recipientKeys.encryption.privateKey, envelope);
  return { sealed: envelope, decrypted: decrypted.toString("utf8") };
}

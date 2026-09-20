import {
  createCipheriv,
  createDecipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { loadEncryptionPrivateKey, loadEncryptionPublicKey } from "./device-key.js";

/** 会话 DEK 长度（AES-256 需要 32 字节密钥） */
export const DEK_LENGTH = 32;

/** HKDF 信息域（区分不同用途的密钥派生） */
const WRAP_INFO = Buffer.from("kcode-dek-wrap");

/**
 * 信封加密结果：DEK 用接收方设备公钥包装（ECDH + AES-GCM），
 * 消息用 DEK 加密。relay 只见密文——仅持有设备私钥的一方能解开。
 */
export interface SealedEnvelope {
  /** 发送方临时公钥（每次加密新生成，提供前向保密） */
  ephemeralPublicKey: Buffer;
  /** ECDH 共享密钥加密的 DEK 密文 */
  wrappedDek: Buffer;
  /** DEK 包装的 nonce */
  dekNonce: Buffer;
  /** DEK 包装的认证标签 */
  dekTag: Buffer;
  /** DEK 加密的消息密文 */
  ciphertext: Buffer;
  /** 消息加密的 nonce */
  messageNonce: Buffer;
  /** 消息加密的认证标签 */
  messageTag: Buffer;
}

/** 生成随机会话 DEK（数据加密密钥，AES-256） */
export function generateDek(): Buffer {
  return randomBytes(DEK_LENGTH);
}

/**
 * 完整的信封加密：生成 DEK → 用接收方公钥包装 DEK → 用 DEK 加密消息。
 * 每次调用生成新的临时密钥对和新的 DEK，天然前向保密。
 */
export function sealMessage(
  plaintext: Buffer,
  recipientPublicKeyDer: Buffer,
): { envelope: SealedEnvelope; dek: Buffer } {
  const dek = generateDek();

  // DEK 包装：临时 X25519 → ECDH → HKDF → AES-256-GCM 加密 DEK
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralPubDer = ephemeral.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const ephemeralPrivObj = ephemeral.privateKey;
  const recipientPubObj = loadEncryptionPublicKey(recipientPublicKeyDer);
  const shared = diffieHellman({ privateKey: ephemeralPrivObj, publicKey: recipientPubObj });
  const wrapKey = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), WRAP_INFO, 32));

  const dekNonce = randomBytes(12);
  const dekCipher = createCipheriv("aes-256-gcm", wrapKey, dekNonce);
  const wrappedDek = Buffer.concat([dekCipher.update(dek), dekCipher.final()]);
  const dekTag = dekCipher.getAuthTag();

  // 消息加密：用 DEK 直接加密
  const messageNonce = randomBytes(12);
  const messageCipher = createCipheriv("aes-256-gcm", dek, messageNonce);
  const ciphertext = Buffer.concat([messageCipher.update(plaintext), messageCipher.final()]);
  const messageTag = messageCipher.getAuthTag();

  return {
    envelope: {
      ephemeralPublicKey: ephemeralPubDer,
      wrappedDek,
      dekNonce,
      dekTag,
      ciphertext,
      messageNonce,
      messageTag,
    },
    dek,
  };
}

/**
 * 完整的信封解密：设备私钥 + 发送方临时公钥 → ECDH → 解开 DEK → 解开消息。
 * 任何一个环节被篡改都会认证失败（GCM 标签校验）。
 */
export function openMessage(
  recipientPrivateKeyDer: Buffer,
  envelope: SealedEnvelope,
): Buffer {
  // 解开 DEK
  const privObj = loadEncryptionPrivateKey(recipientPrivateKeyDer);
  const ephPubObj = loadEncryptionPublicKey(envelope.ephemeralPublicKey);
  const shared = diffieHellman({ privateKey: privObj, publicKey: ephPubObj });
  const wrapKey = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), WRAP_INFO, 32));

  const dekDecipher = createDecipheriv("aes-256-gcm", wrapKey, envelope.dekNonce);
  dekDecipher.setAuthTag(envelope.dekTag);
  const dek = Buffer.concat([dekDecipher.update(envelope.wrappedDek), dekDecipher.final()]);

  // 解开消息
  const msgDecipher = createDecipheriv("aes-256-gcm", dek, envelope.messageNonce);
  msgDecipher.setAuthTag(envelope.messageTag);
  return Buffer.concat([msgDecipher.update(envelope.ciphertext), msgDecipher.final()]);
}

/**
 * 仅包装 DEK（不加密消息）：用于 epoch 轮换时把新 DEK 分发给授权设备。
 * 每个设备独立生成一份信封——互不影响，撤销时不再为该设备生成。
 */
export function wrapDekForDevice(
  dek: Buffer,
  devicePublicKeyDer: Buffer,
): { ephemeralPublicKey: Buffer; wrappedDek: Buffer; dekNonce: Buffer; dekTag: Buffer } {
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralPubDer = ephemeral.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const recipientPubObj = loadEncryptionPublicKey(devicePublicKeyDer);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientPubObj });
  const wrapKey = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), WRAP_INFO, 32));

  const dekNonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wrapKey, dekNonce);
  const wrappedDek = Buffer.concat([cipher.update(dek), cipher.final()]);
  return {
    ephemeralPublicKey: ephemeralPubDer,
    wrappedDek,
    dekNonce,
    dekTag: cipher.getAuthTag(),
  };
}

/**
 * 仅解开 DEK（设备收到 epoch 轮换消息时调用）。
 * 返回解开的 DEK 供后续消息解密使用。
 */
export function unwrapDek(
  devicePrivateKeyDer: Buffer,
  ephemeralPublicKey: Buffer,
  wrappedDek: Buffer,
  dekNonce: Buffer,
  dekTag: Buffer,
): Buffer {
  const privObj = loadEncryptionPrivateKey(devicePrivateKeyDer);
  const ephPubObj = loadEncryptionPublicKey(ephemeralPublicKey);
  const shared = diffieHellman({ privateKey: privObj, publicKey: ephPubObj });
  const wrapKey = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), WRAP_INFO, 32));

  const decipher = createDecipheriv("aes-256-gcm", wrapKey, dekNonce);
  decipher.setAuthTag(dekTag);
  return Buffer.concat([decipher.update(wrappedDek), decipher.final()]);
}

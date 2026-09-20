import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";

/** 设备加密密钥对（X25519）：用于信封加密的密钥协商 */
export interface DeviceEncryptionKey {
  publicKey: Buffer;
  privateKey: Buffer;
}

/** 设备签名密钥对（Ed25519）：用于 relay 连接握手与用量事件签名 */
export interface DeviceSigningKey {
  publicKey: Buffer;
  privateKey: Buffer;
}

/** 设备的完整密钥身份：加密对 + 签名对，DER 编码存储 */
export interface DeviceKeyPair {
  encryption: DeviceEncryptionKey;
  signing: DeviceSigningKey;
}

/** 生成设备密钥对：X25519（加密）+ Ed25519（签名），基于 node:crypto 原生实现 */
export function generateDeviceKeyPair(): DeviceKeyPair {
  const enc = generateKeyPairSync("x25519");
  const sig = generateKeyPairSync("ed25519");
  return {
    encryption: {
      publicKey: enc.publicKey.export({ type: "spki", format: "der" }),
      privateKey: enc.privateKey.export({ type: "pkcs8", format: "der" }),
    },
    signing: {
      publicKey: sig.publicKey.export({ type: "spki", format: "der" }),
      privateKey: sig.privateKey.export({ type: "pkcs8", format: "der" }),
    },
  };
}

/** 用设备签名私钥对消息签名，返回签名字节 */
export function signMessage(privateKeyDer: Buffer, message: Buffer): Buffer {
  const key = createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });
  return edSign(null, message, key);
}

/** 用设备签名公钥验证签名 */
export function verifySignature(publicKeyDer: Buffer, message: Buffer, signature: Buffer): boolean {
  const key = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
  return edVerify(null, message, key, signature);
}

/** 恢复 X25519 私钥对象（供 ECDH 使用） */
export function loadEncryptionPrivateKey(der: Buffer): KeyObject {
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/** 恢复 X25519 公钥对象（供 ECDH 使用） */
export function loadEncryptionPublicKey(der: Buffer): KeyObject {
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

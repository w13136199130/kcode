import { describe, expect, it } from "vitest";
import {
  generateDeviceKeyPair,
  signMessage,
  verifySignature,
  generateDek,
  sealMessage,
  openMessage,
  wrapDekForDevice,
  unwrapDek,
  MessageRatchet,
  SessionCrypto,
  e2eRoundTrip,
  generateRecoveryCode,
  hashRecoveryCode,
  verifyRecoveryCode,
} from "../src/transport/e2e/index.js";

describe("设备密钥对（X25519 + Ed25519）", () => {
  it("生成签名/验签往返", () => {
    const device = generateDeviceKeyPair();
    const message = Buffer.from("设备身份验证消息");
    const signature = signMessage(device.signing.privateKey, message);
    expect(verifySignature(device.signing.publicKey, message, signature)).toBe(true);

    const tampered = Buffer.from("被篡改的消息");
    expect(verifySignature(device.signing.publicKey, tampered, signature)).toBe(false);
  });

  it("不同设备的密钥互不相同", () => {
    const a = generateDeviceKeyPair();
    const b = generateDeviceKeyPair();
    expect(a.encryption.publicKey.equals(b.encryption.publicKey)).toBe(false);
  });
});

describe("信封加密（DEK 包装 + 消息加密）", () => {
  it("加密 → 解密往返一致", () => {
    const recipient = generateDeviceKeyPair();
    const message = "这是一条端到端加密消息";
    const { envelope, dek } = sealMessage(Buffer.from(message, "utf8"), recipient.encryption.publicKey);
    expect(dek.length).toBe(32);

    const decrypted = openMessage(recipient.encryption.privateKey, envelope);
    expect(decrypted.toString("utf8")).toBe(message);
  });

  it("非授权设备无法解密", () => {
    const recipient = generateDeviceKeyPair();
    const eavesdropper = generateDeviceKeyPair();
    const { envelope } = sealMessage(
      Buffer.from("秘密"),
      recipient.encryption.publicKey,
    );
    expect(() => openMessage(eavesdropper.encryption.privateKey, envelope)).toThrow();
  });

  it("密文被篡改时认证失败", () => {
    const recipient = generateDeviceKeyPair();
    const { envelope } = sealMessage(Buffer.from("原始"), recipient.encryption.publicKey);
    envelope.ciphertext[0] = (envelope.ciphertext[0]! + 1) % 256;
    expect(() => openMessage(recipient.encryption.privateKey, envelope)).toThrow();
  });
});

describe("DEK 单独包装（epoch 轮换用）", () => {
  it("wrap → unwrap 往返", () => {
    const device = generateDeviceKeyPair();
    const dek = generateDek();
    const wrapped = wrapDekForDevice(dek, device.encryption.publicKey);
    const unwrapped = unwrapDek(
      device.encryption.privateKey,
      wrapped.ephemeralPublicKey,
      wrapped.wrappedDek,
      wrapped.dekNonce,
      wrapped.dekTag,
    );
    expect(unwrapped.equals(dek)).toBe(true);
  });
});

describe("HKDF 逐消息 ratchet", () => {
  it("同序号派生相同密钥；不同序号密钥不同", () => {
    const dek = generateDek();
    const ratchet = new MessageRatchet(dek);
    const key1 = ratchet.nextKey();
    const key2 = ratchet.nextKey();
    expect(key1.sequence).toBe(1);
    expect(key2.sequence).toBe(2);
    expect(key1.key.equals(key2.key)).toBe(false);

    // 重新派生序号 1 的密钥应一致
    const key1Again = ratchet.deriveKey(1);
    expect(key1Again.equals(key1.key)).toBe(true);
  });

  it("不同 DEK 派生出不同密钥链", () => {
    const dekA = generateDek();
    const dekB = generateDek();
    const ratchetA = new MessageRatchet(dekA);
    const ratchetB = new MessageRatchet(dekB);
    expect(ratchetA.nextKey().key.equals(ratchetB.nextKey().key)).toBe(false);
  });
});

describe("会话加密管理（SessionCrypto）", () => {
  it("加密 → 解密完整链路", () => {
    const session = new SessionCrypto("sess_test");
    const message = "第一条消息";
    const encrypted = session.encrypt(message);
    expect(encrypted.epoch).toBe(0);
    expect(encrypted.sequence).toBe(1);

    const decrypted = session.decrypt(encrypted);
    expect(decrypted.toString("utf8")).toBe(message);
  });

  it("多条消息独立加密，可乱序解密", () => {
    const session = new SessionCrypto("sess_multi");
    const messages = ["第一条", "第二条", "第三条"];
    const encryptedAll = messages.map((m) => ({ m, e: session.encrypt(m) }));

    // 乱序解密（先解第三条，再解第一条）
    const third = session.decrypt(encryptedAll[2]!.e);
    const first = session.decrypt(encryptedAll[0]!.e);
    expect(third.toString("utf8")).toBe("第三条");
    expect(first.toString("utf8")).toBe("第一条");
  });

  it("epoch 轮换后旧密钥解不开新消息", () => {
    const deviceA = generateDeviceKeyPair();
    const deviceB = generateDeviceKeyPair();
    const session = new SessionCrypto("sess_rotate");

    // epoch 0 的消息（旧 DEK 加密）
    session.encrypt("epoch 0 消息");

    // 轮换到 epoch 1（分发给 A、B 两个设备）
    const { newEpoch, envelopes } = session.rotate([
      deviceA.encryption.publicKey,
      deviceB.encryption.publicKey,
    ]);
    expect(newEpoch).toBe(1);
    expect(envelopes).toHaveLength(2);

    // epoch 1 的消息用新密钥
    const newEncrypted = session.encrypt("epoch 1 消息");
    expect(newEncrypted.epoch).toBe(1);
    const decrypted = session.decrypt(newEncrypted);
    expect(decrypted.toString("utf8")).toBe("epoch 1 消息");

    // 设备 B 应用轮换
    const sessionB = new SessionCrypto("sess_rotate");
    sessionB.applyRotation(
      deviceB.encryption.privateKey,
      envelopes[1]!,
      newEpoch,
    );
    const decryptedB = sessionB.decrypt(newEncrypted);
    expect(decryptedB.toString("utf8")).toBe("epoch 1 消息");

    // 被撤销的设备（未收到新信封）无法解密新 epoch 消息
    const revokedSession = new SessionCrypto("sess_rotate");
    // revokedSession 没有调用 applyRotation，仍持有旧 DEK
    expect(() => revokedSession.decrypt(newEncrypted)).toThrow();
  });

  it("e2eRoundTrip 集成验证", () => {
    const alice = generateDeviceKeyPair();
    const bob = generateDeviceKeyPair();
    const result = e2eRoundTrip(alice, bob, "Hello E2E!");
    expect(result.decrypted).toBe("Hello E2E!");
    // 密文不含明文
    const ciphertextStr = Buffer.from(result.sealed.ciphertext).toString("utf8");
    expect(ciphertextStr).not.toContain("Hello E2E!");
  });
});

describe("恢复码", () => {
  it("生成格式合规（16 位、连字符分隔、排除易混淆字符）", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[A-HJ-KM-NP-Z2-9]{4}(-[A-HJ-KM-NP-Z2-9]{4}){3}$/);
  });

  it("哈希验证（正确通过，错误拒绝）", () => {
    const code = generateRecoveryCode();
    const hash = hashRecoveryCode(code);
    expect(verifyRecoveryCode(code, hash)).toBe(true);
    expect(verifyRecoveryCode("WRONG-CODE-XXXX-XXXX", hash)).toBe(false);
  });

  it("空格与大小写容错", () => {
    const code = generateRecoveryCode();
    const hash = hashRecoveryCode(code);
    expect(verifyRecoveryCode(code.toLowerCase(), hash)).toBe(true);
    expect(verifyRecoveryCode(`  ${code}  `, hash)).toBe(true);
  });
});

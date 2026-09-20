import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 恢复码格式：XXXX-XXXX-XXXX-XXXX（16 位 base32，人类可抄写） */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 排除易混淆的 I/L/O/0/1

/** 生成恢复码：用于设备全部丢失时重置会话密钥。用户应离线抄写保管。 */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(16);
  const chars: string[] = [];
  for (let i = 0; i < 16; i++) {
    chars.push(ALPHABET[bytes[i]! % ALPHABET.length]!);
  }
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}-${chars.slice(12, 16).join("")}`;
}

/** 计算恢复码的哈希（服务端只存哈希，不存明文） */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.toUpperCase().trim()).digest("hex");
}

/** 验证恢复码（常量时间比较，防时序攻击） */
export function verifyRecoveryCode(code: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashRecoveryCode(code), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (candidate.length !== stored.length) {
    return false;
  }
  return timingSafeEqual(candidate, stored);
}

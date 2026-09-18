import { z } from "zod";

/** daemon ↔ relay WSS 协议消息（§5.6；P4 落地，P0 定型最小集） */

const b64 = z.string().regex(/^[A-Za-z0-9+/=]+$/);
const sessionId = z.string().min(1);

/** 密文透传：relay 只见密文与路由元数据（零知识指内容，元数据仍可见——§7 已知边界） */
export const CiphertextMessage = z.object({
  kind: z.literal("ciphertext"),
  sessionId,
  epoch: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  nonce: b64,
  payload: b64,
});

/** 设备握手：设备私钥签名认证（relay 设备授权表的准入依据，§5.6.1） */
export const DeviceHello = z.object({
  kind: z.literal("device_hello"),
  deviceId: z.string().min(1),
  ts: z.number().int().nonnegative(),
  signature: b64,
});

/** §5.3 会话锁租约：60s TTL / 15s 心跳，租约丢失方自动转只读 */
export const LeaseMessage = z.object({
  kind: z.literal("lease"),
  sessionId,
  holder: z.string().min(1),
  ttlMs: z.number().int().positive(),
  heartbeatMs: z.number().int().positive(),
});

export const RelayMessage = z.discriminatedUnion("kind", [
  CiphertextMessage,
  DeviceHello,
  LeaseMessage,
]);
export type RelayMessage = z.infer<typeof RelayMessage>;

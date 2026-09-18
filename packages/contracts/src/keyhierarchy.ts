import { z } from "zod";

/** §5.6.1 E2E 密钥层级（epoch 模型，ADR-12） */

const b64 = z.string().regex(/^[A-Za-z0-9+/=]+$/);

export const DevicePublicKey = z.object({
  deviceId: z.string().min(1),
  algorithm: z.literal("ed25519"),
  publicKey: b64,
  createdAt: z.number().int().nonnegative(),
});
export type DevicePublicKey = z.infer<typeof DevicePublicKey>;

/** 会话 DEK 信封：某 epoch 的 DEK 用某授权设备公钥包装；relay 永远只见密文 */
export const DekEnvelope = z.object({
  sessionId: z.string().min(1),
  epoch: z.number().int().nonnegative(),
  deviceId: z.string().min(1),
  wrappedDek: b64,
  algo: z.literal("libsodium-seal"),
});
export type DekEnvelope = z.infer<typeof DekEnvelope>;

/**
 * 撤销/添加设备 => epoch+1：生成新 DEK 只包给剩余设备。
 * 仅重包旧信封对已解包过 DEK 的设备无效——v1.0 方案错误，v1.1 修正。
 */
export const EpochRotateMessage = z.object({
  type: z.literal("epoch_rotate"),
  sessionId: z.string().min(1),
  fromEpoch: z.number().int().nonnegative(),
  toEpoch: z.number().int().nonnegative(),
  newEnvelopes: z.array(DekEnvelope).min(1),
  reason: z.enum(["device_added", "device_revoked", "periodic"]),
});
export type EpochRotateMessage = z.infer<typeof EpochRotateMessage>;

/** relay 侧每会话设备授权表（设备连接以私钥签名握手认证，纵深防御） */
export interface DeviceAcl {
  sessionId: string;
  epoch: number;
  authorized: string[];
  revoked: string[];
}

import { z } from "zod";

/** §5.6.3 更新链（ADR-11，TUF 角色分离：离线 root / 在线 release / timestamp） */

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const b64 = z.string().regex(/^[A-Za-z0-9+/=]+$/);
const tsField = z.number().int().nonnegative();

export const SigningKey = z.object({
  kid: z.string().min(1),
  algorithm: z.literal("ed25519"),
  publicKey: b64,
  expiresAt: tsField,
});
export type SigningKey = z.infer<typeof SigningKey>;

export const UpdateArtifact = z.object({
  platform: z.enum(["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64"]),
  url: z.string().url(),
  sha256,
});

/** 在线 release key 签的发版清单 */
export const ReleaseManifest = z.object({
  schema: z.literal("kcode.tuf.release/1"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  minSupported: z.string().regex(/^\d+\.\d+\.\d+$/),
  artifacts: z.array(UpdateArtifact).min(1),
  issuedAt: tsField,
  expiresAt: tsField,
});
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;

/** 离线 root key 签的钥匙表：CI release key 泄露时重签本表即轮换，无需发客户端版本 */
export const RootManifest = z.object({
  schema: z.literal("kcode.tuf.root/1"),
  version: z.number().int().positive(),
  rootKeys: z.array(SigningKey).min(1),
  releaseKeys: z.array(SigningKey).min(1),
  timestampKeys: z.array(SigningKey).min(1),
  issuedAt: tsField,
});
export type RootManifest = z.infer<typeof RootManifest>;

/** timestamp 角色：短时效清单，防回滚攻击（Uptane 同款思路） */
export const TimestampManifest = z.object({
  schema: z.literal("kcode.tuf.timestamp/1"),
  releaseManifestSha256: sha256,
  issuedAt: tsField,
  expiresAt: tsField,
});
export type TimestampManifest = z.infer<typeof TimestampManifest>;

/** relay 下发的带签名最低版本声明：杜绝中间人/仿冒页面伪造"必须升级"钓鱼 */
export const MinVersionAttestation = z.object({
  schema: z.literal("kcode.min-version/1"),
  minSupported: z.string().regex(/^\d+\.\d+\.\d+$/),
  issuedAt: tsField,
  expiresAt: tsField,
  keyId: z.string().min(1),
  signature: b64,
});
export type MinVersionAttestation = z.infer<typeof MinVersionAttestation>;

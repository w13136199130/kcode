import { z } from "zod";

/**
 * §5.7 计量事件（设备签名后批量上报）。
 * BYOK 模式上报前 sessionId 必须替换为假名 pseudonym = HMAC(deviceKey, sessionId)——
 * 防用量事件与服务端 relay 元数据（时间/规模）关联；网关模式保留可关联性用于计费。
 */
export const UsageEvent = z.object({
  type: z.literal("usage"),
  ts: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative().optional(),
  priceTableVersion: z.string().min(1),
});
export type UsageEvent = z.infer<typeof UsageEvent>;

/** 计量上报端口（platform/usage 实现） */
export interface UsageReporter {
  report(event: UsageEvent): Promise<void>;
}

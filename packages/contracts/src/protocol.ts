import { z } from "zod";

/**
 * 跨进程协议契约（先冻结形状，再写实现）：
 * - 主版本不一致拒绝连接（不再静默错配），次版本用于能力协商（向前兼容）；
 * - 协议类型与运行时校验同源 zod——改协议必须同时过类型检查与运行时校验。
 */

export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 0;

/** 握手消息：双方交换并校验主版本；capabilities 声明各自支持的能力 */
export const ProtocolHello = z.object({
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
  capabilities: z.array(z.string()),
});
export type ProtocolHello = z.infer<typeof ProtocolHello>;

/** 命令信封：commandId 幂等（同 id 重试不重复执行），baseRevision 做 CAS 防 stale run */
export const CommandEnvelope = z.object({
  commandId: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown(),
  baseRevision: z.number().int().nonnegative().optional(),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;

/** 事件游标：logEpoch + seq 定位快照/增量，订阅方据此断点续传而非整量重推 */
export const EventCursor = z.object({
  logEpoch: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
});
export type EventCursor = z.infer<typeof EventCursor>;

/** 校验远端握手主版本：不一致抛错并给出可操作提示 */
export function assertCompatibleHello(remote: ProtocolHello, localMajor: number = PROTOCOL_MAJOR): void {
  if (remote.major !== localMajor) {
    throw new Error(
      `协议主版本不一致：本端 v${localMajor}，远端 v${remote.major}——需升级到同一主版本（次版本可向前兼容）`,
    );
  }
}

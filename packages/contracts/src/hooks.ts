import { z } from "zod";

export const HookEventName = z.enum([
  "session_start",
  "pre_tool_use",
  "post_tool_use",
  "stop",
]);
export type HookEventName = z.infer<typeof HookEventName>;

export const HookPayload = z.object({
  event: HookEventName,
  sessionId: z.string().min(1),
  ts: z.number().int().nonnegative(),
  tool: z.string().optional(),
  args: z.unknown().optional(),
  result: z.unknown().optional(),
});
export type HookPayload = z.infer<typeof HookPayload>;

export const HookOutcome = z
  .object({
    action: z.enum(["allow", "block", "mutate"]),
    reason: z.string().optional(),
    args: z.unknown().optional(),
  })
  .strict();
export type HookOutcome = z.infer<typeof HookOutcome>;

/** 单条钩子配置：事件 + 命令行（经 shell 执行，stdin 收到 JSON 载荷） */
export const HookConfig = z.object({
  event: HookEventName,
  command: z.string().min(1),
  /** 执行超时（毫秒），默认 10 秒；超时按放行处理并告警 */
  timeoutMs: z.number().int().positive().optional(),
});
export type HookConfig = z.infer<typeof HookConfig>;

/** 钩子配置文件：{ "hooks": [{ event, command }] } */
export const HookConfigFile = z
  .object({
    hooks: z.array(HookConfig).default([]),
  })
  .strict();
export type HookConfigFile = z.infer<typeof HookConfigFile>;

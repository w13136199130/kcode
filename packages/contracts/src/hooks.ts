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

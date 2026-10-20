import { z } from "zod";

export const HookEventName = z.enum([
  "session_start",
  "pre_tool_use",
  "post_tool_use",
  "user_prompt_submit",
  "pre_compact",
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
    /** 3-15：追加到模型上下文（与 CC hookSpecificOutput.additionalContext 同义） */
    additionalContext: z.string().optional(),
  })
  .strict();
export type HookOutcome = z.infer<typeof HookOutcome>;

/** 单条钩子配置：事件 + 命令行（经 shell 执行，stdin 收到 JSON 载荷） */
export const HookConfig = z.object({
  event: HookEventName,
  command: z.string().min(1),
  /**
   * 3-15：工具事件匹配器（工具名或正则，大小写不敏感）；空 = 全部工具。
   * 非工具事件忽略（加载时告警）。
   */
  matcher: z.string().optional(),
  /**
   * 3-16：执行工作目录（插件 hooks 指向插件安装目录；缺省进程 cwd）
   */
  cwd: z.string().min(1).optional(),
  /** 执行超时（毫秒），默认 10 秒；超时按放行处理并告警 */
  timeoutMs: z.number().int().positive().optional(),
  /** 安全钩子模式：超时/执行失败按拦截处理（fail-closed）。默认 false（fail-open，钩子故障不阻断会话） */
  failClosed: z.boolean().optional(),
});
export type HookConfig = z.infer<typeof HookConfig>;

/** 钩子配置文件：{ "hooks": [{ event, command }] }；CC 形态由 loader 归一化（3-15） */
export const HookConfigFile = z
  .object({
    hooks: z.unknown().optional(),
  })
  .passthrough();
export type HookConfigFile = z.infer<typeof HookConfigFile>;

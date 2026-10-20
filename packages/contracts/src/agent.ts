import { z } from "zod";

/**
 * 子代理清单（.kcode/agents/<name>.md 的 frontmatter，B1）：
 * 子代理 = 独立上下文的 AgentLoop 实例（自带工具子集/权限/提示），由 task 工具派生。
 * tools 为空 = 继承 general-purpose 全集；model 缺省 = 沿用父会话当前模型。
 */
export const SubagentManifest = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-_.]{1,63}$/),
  description: z.string().min(1).max(500),
  /** 可用工具名清单（空 = 全集）；内置 explore 恒为只读集 */
  tools: z.array(z.string()).default([]),
  model: z.string().optional(),
  /**
   * 3-19：子代理权限档（CC permissionMode 的收敛子集）。
   * plan = 只读（父会话 plan 档只允许派生这种子代理）；acceptEdits 仅影响写类确认语义。
   */
  permissionMode: z.enum(["plan", "default", "acceptEdits"]).optional(),
  /** 3-19：从可用工具中剔除的工具名（比 tools 白名单更细的减法） */
  disallowedTools: z.array(z.string()).default([]),
  /** 3-19：子代理轮次上限（缺省 12，最大 50） */
  maxTurns: z.number().int().min(1).max(50).optional(),
});
export type SubagentManifest = z.infer<typeof SubagentManifest>;

/** 内置子代理类型（task 工具的 subagent_type 保留名） */
export const BUILTIN_SUBAGENT_TYPES = ["general-purpose", "explore"] as const;
export type BuiltinSubagentType = (typeof BUILTIN_SUBAGENT_TYPES)[number];

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
});
export type SubagentManifest = z.infer<typeof SubagentManifest>;

/** 内置子代理类型（task 工具的 subagent_type 保留名） */
export const BUILTIN_SUBAGENT_TYPES = ["general-purpose", "explore"] as const;
export type BuiltinSubagentType = (typeof BUILTIN_SUBAGENT_TYPES)[number];

import { z } from "zod";
import { PermissionDecision } from "./tool.js";

/**
 * 权限规则（§5.1/§7）：按工具名模式匹配，首条命中生效。
 * automation 模式（§5.5）下 ask 一律降级为 deny + 记录 + 通知。
 */
export const PermissionRule = z.object({
  /** 工具名模式：精确名或 * 通配（插件工具带 plugin:<name>:: 前缀） */
  match: z.string().min(1),
  decision: PermissionDecision,
});
export type PermissionRule = z.infer<typeof PermissionRule>;

export const PermissionRuleSet = z.array(PermissionRule);
export type PermissionRuleSet = z.infer<typeof PermissionRuleSet>;

import { z } from "zod";
import { PermissionDecision } from "./tool.js";

/**
 * 权限模式四档（对齐主流 CLI 的层级）：
 * - plan：只读研究，写/命令拒绝（§1.1 A 域计划模式）
 * - default：读放行，写/命令逐次确认（本地默认姿态）
 * - acceptEdits：读+文件编辑自动放行，命令仍确认
 * - fullAccess：全自动（等价 yolo；进入需显式确认）
 */
export const PermissionMode = z.enum(["plan", "default", "acceptEdits", "fullAccess"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

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

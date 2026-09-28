import type { PermissionMode } from "@kcode/contracts";

/** 四档权限模式的界面元数据（与 extensions/RULES_BY_MODE 一一对应）；符号用等宽字形不用 emoji */
export const MODE_META: Record<PermissionMode, { label: string; hint: string; color: string }> = {
  plan: { label: "只读", hint: "写/命令将被拒绝", color: "magenta" },
  default: { label: "变更确认", hint: "写/命令逐次确认", color: "cyan" },
  acceptEdits: { label: "自动编辑", hint: "编辑自动放行，命令仍确认", color: "green" },
  fullAccess: { label: "完全访问", hint: "全自动，谨慎使用", color: "red" },
};

/** /mode 循环切换顺序：fullAccess 不进循环，只能显式指定并确认 */
export const MODE_CYCLE: PermissionMode[] = ["plan", "default", "acceptEdits"];

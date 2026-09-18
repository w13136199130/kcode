import type { PermissionDecision, PermissionEngine, PermissionRule, ToolDefinition } from "@kcode/contracts";

/** 只读预设：查询全放行，其余全拒绝（远程会话默认姿态的本地版，§7） */
export const READONLY_RULES: PermissionRule[] = [
  { match: "read", decision: "allow" },
  { match: "glob", decision: "allow" },
  { match: "grep", decision: "allow" },
  { match: "*", decision: "deny" },
];

/** 默认预设：读放行、写/命令询问、未知工具拒绝（§7 本地默认姿态） */
export const DEFAULT_RULES: PermissionRule[] = [
  { match: "read", decision: "allow" },
  { match: "glob", decision: "allow" },
  { match: "grep", decision: "allow" },
  { match: "write", decision: "ask" },
  { match: "edit", decision: "ask" },
  { match: "bash", decision: "ask" },
  { match: "plugin:*", decision: "ask" },
  { match: "mcp__*", decision: "ask" },
  { match: "*", decision: "deny" },
];

/** 全放行（等价 P0 allowAll；仅用于可信沙箱/测试） */
export const YOLO_RULES: PermissionRule[] = [{ match: "*", decision: "allow" }];

/**
 * automation 装饰器（§5.5）：无人值守会话 ask 一律降级 deny——
 * 要么预授权 allowlist（建任务时声明），要么拒绝留审计；通知由 scheduler 层补（P5）。
 */
export class AutomationPermissionEngine implements PermissionEngine {
  constructor(private readonly inner: PermissionEngine) {}

  async decide(tool: ToolDefinition, args: unknown): Promise<PermissionDecision> {
    const decision = await this.inner.decide(tool, args);
    return decision === "ask" ? "deny" : decision;
  }
}

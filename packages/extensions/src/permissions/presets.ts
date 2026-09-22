import type {
  PermissionDecision,
  PermissionEngine,
  PermissionMode,
  PermissionRule,
  ToolDefinition,
} from "@kcode/contracts";

/** 只读预设：查询/会话态放行，其余全拒绝（远程会话默认姿态的本地版，§7） */
export const READONLY_RULES: PermissionRule[] = [
  { match: "read", decision: "allow" },
  { match: "glob", decision: "allow" },
  { match: "grep", decision: "allow" },
  { match: "extract", decision: "allow" },
  { match: "web_fetch", decision: "allow" },
  { match: "web_search", decision: "allow" },
  { match: "todo", decision: "allow" },
  { match: "ask_user", decision: "allow" },
  { match: "sessions", decision: "allow" },
  { match: "plan_submit", decision: "allow" },
  { match: "*", decision: "deny" },
];

/** 默认预设：读放行、写/命令询问、未知工具拒绝（§7 本地默认姿态） */
export const DEFAULT_RULES: PermissionRule[] = [
  { match: "read", decision: "allow" },
  { match: "glob", decision: "allow" },
  { match: "grep", decision: "allow" },
  { match: "extract", decision: "allow" },
  { match: "web_fetch", decision: "allow" },
  { match: "web_search", decision: "allow" },
  { match: "todo", decision: "allow" },
  { match: "ask_user", decision: "allow" },
  { match: "sessions", decision: "allow" },
  { match: "write", decision: "ask" },
  { match: "edit", decision: "ask" },
  { match: "bash", decision: "ask" },
  { match: "plugin:*", decision: "ask" },
  { match: "mcp__*", decision: "ask" },
  { match: "task", decision: "allow" },
  { match: "plan_submit", decision: "allow" },
  { match: "*", decision: "deny" },
];

/** 全放行（等价 P0 allowAll；仅用于可信沙箱/测试） */
export const YOLO_RULES: PermissionRule[] = [{ match: "*", decision: "allow" }];

/** 自动编辑预设（acceptEdits 档）：读+文件写入放行，命令/插件/MCP 仍逐次确认 */
export const ACCEPT_EDITS_RULES: PermissionRule[] = [
  { match: "read", decision: "allow" },
  { match: "glob", decision: "allow" },
  { match: "grep", decision: "allow" },
  { match: "extract", decision: "allow" },
  { match: "web_fetch", decision: "allow" },
  { match: "web_search", decision: "allow" },
  { match: "todo", decision: "allow" },
  { match: "ask_user", decision: "allow" },
  { match: "sessions", decision: "allow" },
  { match: "write", decision: "allow" },
  { match: "edit", decision: "allow" },
  { match: "bash", decision: "ask" },
  { match: "plugin:*", decision: "ask" },
  { match: "mcp__*", decision: "ask" },
  { match: "task", decision: "allow" },
  { match: "*", decision: "deny" },
];

/** 四档权限模式 → 规则集（composition 切档时整体替换基础引擎） */
export const RULES_BY_MODE: Record<PermissionMode, PermissionRule[]> = {
  plan: READONLY_RULES,
  default: DEFAULT_RULES,
  acceptEdits: ACCEPT_EDITS_RULES,
  fullAccess: YOLO_RULES,
};

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

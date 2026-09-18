import type {
  PermissionDecision,
  PermissionEngine,
  PermissionRule,
  ToolDefinition,
} from "@kcode/contracts";

export interface RuleEngineOptions {
  /** 规则按序匹配，首条命中生效 */
  rules: PermissionRule[];
  /** 无规则命中时的默认裁决（安全缺省 deny） */
  fallback?: PermissionDecision;
}

/** 规则驱动权限引擎（§5.1 纯本地裁决、快；§7 工具级 allow/ask/deny） */
export class RuleBasedPermissionEngine implements PermissionEngine {
  private readonly fallback: PermissionDecision;

  constructor(private readonly options: RuleEngineOptions) {
    this.fallback = options.fallback ?? "deny";
  }

  async decide(tool: ToolDefinition, _args: unknown): Promise<PermissionDecision> {
    for (const rule of this.options.rules) {
      if (matchTool(rule.match, tool.name)) {
        return rule.decision;
      }
    }
    return this.fallback;
  }
}

/** 工具名模式匹配：* 通配（如 "write"、"mcp__*"、"plugin:code-review::*"） */
export function matchTool(pattern: string, toolName: string): boolean {
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return regex.test(toolName);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

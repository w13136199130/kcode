import type {
  PermissionDecision,
  PermissionEngine,
  PermissionMode,
  ToolDefinition,
} from "@kcode/contracts";
import { safeBashDecision } from "./safe-commands.js";

/**
 * 未声明 permission 的工具（MCP/插件/未知注册物）在各档的回退（N2-3）：
 * plan 只读姿态最严（deny），default/acceptEdits 走人工确认，fullAccess 恒 allow。
 */
export const MODE_FALLBACK: Record<PermissionMode, PermissionDecision> = {
  plan: "deny",
  default: "ask",
  acceptEdits: "ask",
  fullAccess: "allow",
};

/**
 * 档位引擎（N2-3 ToolEntry 声明驱动，取代四份按工具名维护的模式名单）：
 * 1. fullAccess 恒 allow；2. 工具声明优先（plan 缺省按 readOnly 推导，acceptEdits 缺省同 default）；
 * 3. 未声明（MCP/插件）按 MODE_FALLBACK 回退。会话级放行/项目持久放行由外层 MutablePermissionEngine 叠加。
 */
export class ModePermissionEngine implements PermissionEngine {
  constructor(private readonly mode: PermissionMode) {}

  async decide(tool: ToolDefinition, _args: unknown): Promise<PermissionDecision> {
    if (this.mode === "fullAccess") {
      return "allow";
    }
    const declared = tool.permission;
    if (declared === undefined) {
      return MODE_FALLBACK[this.mode];
    }
    if (this.mode === "plan") {
      return declared.plan ?? (tool.readOnly ? "allow" : "deny");
    }
    if (this.mode === "acceptEdits") {
      return safeBashDecision(tool.name, _args, declared.acceptEdits ?? declared.default);
    }
    return safeBashDecision(tool.name, _args, declared.default);
  }
}

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

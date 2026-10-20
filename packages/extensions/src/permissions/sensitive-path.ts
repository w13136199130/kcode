import type {
  PermissionDecision,
  PermissionEngine,
  PermissionMode,
  ToolDefinition,
} from "@kcode/contracts";
import { sensitivePathFromArgs } from "@kcode/shared";

/**
 * 2-14：敏感路径保护装饰器。
 * - fullAccess：显式信任，放行（但仍由工具侧过滤 glob 输出，避免误列）。
 * - plan：直接 deny（只读研究也不该读私钥/.env）。
 * - default / acceptEdits：ask（headless 无 asker 时既有管线会降级 deny）。
 *
 * 放在 MutablePermissionEngine 外层：会话级/项目级放行不能绕过这里。
 */
export class SensitivePathPermissionEngine implements PermissionEngine {
  constructor(
    private readonly inner: PermissionEngine,
    private readonly mode: () => PermissionMode,
  ) {}

  async decide(tool: ToolDefinition, args: unknown): Promise<PermissionDecision> {
    const mode = this.mode();
    if (mode !== "fullAccess" && sensitivePathFromArgs(tool.name, args)) {
      return mode === "plan" ? "deny" : "ask";
    }
    return this.inner.decide(tool, args);
  }
}

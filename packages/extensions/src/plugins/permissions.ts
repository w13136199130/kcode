import type { PermissionDecision, PermissionEngine, ToolDefinition } from "@kcode/contracts";

/**
 * 3-16 插件权限接线：manifest.permissions 只允许**收紧**（ask/deny），不允许提权。
 * 语法：`<工具名>:ask` / `<工具名>:deny`；`allow` 或未知决策在安装/装载期直接拒装，
 * 避免"同意摘要里写了权限、实际被静默忽略"。
 * 运行期由 PluginPermissionEngine 包在既有引擎之外：命中规则直接裁决，否则委托原引擎。
 */
export interface ParsedPluginPermissions {
  rules: Map<string, "ask" | "deny">;
  errors: string[];
}

export function parsePluginPermissions(permissions: readonly string[]): ParsedPluginPermissions {
  const rules = new Map<string, "ask" | "deny">();
  const errors: string[] = [];
  for (const raw of permissions) {
    const text = raw.trim();
    const match = /^([^:\s]+):([a-z]+)$/.exec(text);
    if (match === null) {
      errors.push(`无法解析「${raw}」（期望 <工具名>:ask 或 <工具名>:deny）`);
      continue;
    }
    const [, tool, decision] = match;
    if (decision !== "ask" && decision !== "deny") {
      errors.push(`「${raw}」不允许提权：只支持 ask/deny（allow 由宿主权限档决定）`);
      continue;
    }
    const previous = rules.get(tool!);
    // 多插件冲突：deny 优先（fail-closed）
    rules.set(tool!, previous === "deny" || decision === "deny" ? "deny" : "ask");
  }
  return { rules, errors };
}

/** 把插件权限规则套在既有引擎外；规则只能收紧，不改变其他工具的裁决 */
export class PluginPermissionEngine implements PermissionEngine {
  readonly #base: PermissionEngine;
  readonly #rules: ReadonlyMap<string, "ask" | "deny">;

  constructor(base: PermissionEngine, rules: ReadonlyMap<string, "ask" | "deny">) {
    this.#base = base;
    this.#rules = rules;
  }

  decide(tool: ToolDefinition, args: unknown): PermissionDecision | Promise<PermissionDecision> {
    const forced = this.#rules.get(tool.name);
    return forced ?? this.#base.decide(tool, args);
  }
}

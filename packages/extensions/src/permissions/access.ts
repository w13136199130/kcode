import type { PermissionDecision, PermissionEngine, ToolDefinition } from "@kcode/contracts";

export type AccessMode = "read-only" | "workspace-write";

/** 顶层访问模式：read-only 对所有非只读工具硬拒绝，独立于 /mode 与 srt。 */
export function accessModeFromEnv(env: NodeJS.ProcessEnv = process.env): AccessMode {
  return env["KCODE_ACCESS_MODE"] === "read-only" ? "read-only" : "workspace-write";
}

export class ReadOnlyAccessEngine implements PermissionEngine {
  readonly #inner: PermissionEngine;

  constructor(inner: PermissionEngine) {
    this.#inner = inner;
  }

  async decide(tool: ToolDefinition, args: unknown): Promise<PermissionDecision> {
    // 与 ModePermissionEngine 的 plan 档同一口径：只读工具放行；
    // 写/命令/MCP 等未声明 readOnly 的工具一律拒绝。
    if (tool.readOnly !== true) return "deny";
    return this.#inner.decide(tool, args);
  }
}

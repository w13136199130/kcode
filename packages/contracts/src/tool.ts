import { z } from "zod";

export const PermissionDecision = z.enum(["allow", "ask", "deny"]);
export type PermissionDecision = z.infer<typeof PermissionDecision>;

/** 工具名：内置走简名；插件注册物强制 plugin:<name>:: 命名空间（§4.3） */
export const TOOL_NAME_RE = /^(?:[a-z][a-z0-9_]{0,63}|plugin:[a-z0-9][a-z0-9-_.]{1,63}::.+)$/;

export const ToolDefinition = z.object({
  name: z.string().regex(TOOL_NAME_RE),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()), // JSON Schema
  readOnly: z.boolean().default(false),
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;

export interface ToolContext {
  sessionId: string;
}

export interface ToolOutput {
  ok: boolean;
  output: string;
  error?: string;
}

/** 统一 Tool 抽象（§5.4）：内置工具与 MCP 工具实现同一接口，permissions/hooks/审计只写一遍 */
export interface Tool {
  definition: ToolDefinition;
  execute(input: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

export interface ToolRegistry {
  list(): Tool[];
  get(name: string): Tool | undefined;
}

/** 权限引擎端口（纯本地裁决、快；实现注入自 extensions/permissions，§5.1） */
export interface PermissionEngine {
  decide(
    tool: ToolDefinition,
    args: unknown,
  ): PermissionDecision | Promise<PermissionDecision>;
}

export interface ToolCallRef {
  callId: string;
  tool: string;
  args: unknown;
}

export interface HookPreOutcome {
  veto: boolean;
  args?: unknown;
  reason?: string;
}

/** hooks 端口（§5.4：stdin JSON、退出码/JSON 决定放行或拦截；P3 接进程实现） */
export interface HookRunner {
  preToolUse(call: ToolCallRef): Promise<HookPreOutcome>;
  postToolUse(call: ToolCallRef, result: ToolOutput): Promise<void>;
}

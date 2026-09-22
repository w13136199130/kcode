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
  /** 本次工具调用的 callId（与 tool_call 事件对应；检查点/审计关联用） */
  callId?: string;
  /** 会话工作目录（daemon 注入）；工具的相对路径以此为基准 */
  cwd?: string;
  /** 用户中断信号（Esc/Ctrl+C）：长任务工具（bash 等）应监听并终止子进程 */
  signal?: AbortSignal;
}

export interface ToolOutput {
  ok: boolean;
  output: string;
  error?: string;
  /**
   * 工具产出的图片文件路径（extract 图片提取用）：
   * loop 会以带图 user 消息注入后续请求，供视觉模型查看；
   * 文本模型忽略。最多挂载 3 张（成本护栏）。
   */
  imagePaths?: string[];
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

/** hooks 端口（stdin JSON、退出码/JSON 决定放行或拦截；进程执行由 extensions 实现） */
export interface HookRunner {
  preToolUse(call: ToolCallRef): Promise<HookPreOutcome>;
  postToolUse(call: ToolCallRef, result: ToolOutput): Promise<void>;
  /** 会话开始钩子（可选实现；失败不阻断会话） */
  onSessionStart?(payload: { sessionId: string }): Promise<void>;
  /** 会话结束钩子（可选实现；失败不阻断会话） */
  onStop?(payload: { sessionId: string }): Promise<void>;
}

/** ask 应答：除是否放行外，可选「本会话总是允许」或「本项目总是允许」（持久落盘） */
export interface PermissionAnswer {
  allowed: boolean;
  scope?: "once" | "session" | "project";
}

/**
 * ask 交互确认端口：权限裁决为 ask 时由组合层（CLI/daemon）注入实现；
 * 无实现则按 deny 处理——headless/automation 同款降级语义（§5.5）。
 * 返回布尔视为 { allowed } 的简写（测试/evals 的最小实现保持兼容）。
 */
export interface PermissionAsker {
  confirm(call: ToolCallRef): Promise<boolean | PermissionAnswer>;
}

/** 归一化 asker 应答：布尔 → { allowed }；对象取字段 */
export function normalizePermissionAnswer(answer: boolean | PermissionAnswer): PermissionAnswer {
  if (typeof answer === "boolean") {
    return { allowed: answer };
  }
  return answer;
}

/** 结构化提问（§1.1 A 域）：agent 向用户提出选择题 */
export const QuestionOption = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

export const StructuredQuestion = z.object({
  question: z.string().min(1),
  options: z.array(QuestionOption).min(2),
  multiSelect: z.boolean().optional(),
});
export type StructuredQuestion = z.infer<typeof StructuredQuestion>;

/** 用户应答端口：TUI/daemon 注入；不可交互时工具返回降级话术 */
export interface UserPromptPort {
  ask(question: StructuredQuestion): Promise<string[]>;
}

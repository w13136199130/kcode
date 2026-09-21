import { z } from "zod";

/** 会话 JSONL 事件流（ADR-7：append-only + `v` 版本字段） */
export const SESSION_SCHEMA_VERSION = 1;

const v1 = z.literal(1);
const ts = z.number().int().nonnegative();
const sessionId = z.string().min(1);

export const SessionStartEvent = z.object({
  v: v1,
  type: z.literal("session_start"),
  ts,
  sessionId,
  cwd: z.string().optional(),
  model: z.string().optional(),
});

export const UserMessageEvent = z.object({
  v: v1,
  type: z.literal("user_message"),
  ts,
  sessionId,
  content: z.string(),
});

export const AssistantMessageEvent = z.object({
  v: v1,
  type: z.literal("assistant_message"),
  ts,
  sessionId,
  content: z.string(),
  /** 思考过程原文（resume 回看用；rebuildHistory 不回传 API） */
  reasoning: z.string().optional(),
});

export const ToolCallEvent = z.object({
  v: v1,
  type: z.literal("tool_call"),
  ts,
  sessionId,
  callId: z.string().min(1),
  tool: z.string().min(1),
  args: z.unknown(),
});

export const ToolResultEvent = z.object({
  v: v1,
  type: z.literal("tool_result"),
  ts,
  sessionId,
  callId: z.string().min(1),
  ok: z.boolean(),
  output: z.string(),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

export const CompactionSummaryEvent = z.object({
  v: v1,
  type: z.literal("compaction_summary"),
  ts,
  sessionId,
  summary: z.string(),
  dropped: z.number().int().nonnegative(),
});

/** Todo 任务项（§1.1 A 域）：同一时刻至多一个 in_progress */
export const TodoItem = z.object({
  content: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
  priority: z.enum(["high", "medium", "low"]).default("medium"),
});
export type TodoItem = z.infer<typeof TodoItem>;

export const TodoUpdateEvent = z.object({
  v: v1,
  type: z.literal("todo_update"),
  ts,
  sessionId,
  todos: z.array(TodoItem),
});

/** 技能命中并注入上下文（§5.2 渐进加载；回放时据此重注入正文） */
export const SkillUsedEvent = z.object({
  v: v1,
  type: z.literal("skill_used"),
  ts,
  sessionId,
  skill: z.string().min(1),
  trigger: z.enum(["auto", "manual"]),
});

export const SessionEndEvent = z.object({
  v: v1,
  type: z.literal("session_end"),
  ts,
  sessionId,
  reason: z.enum(["completed", "aborted"]),
});

/**
 * 权限决策落盘（审计/resume 可见）：规则裁决与 ask 应答各记一条；
 * ask-allowed/ask-denied 为用户交互结果，scope=session 会话级放行、scope=project 项目级持久放行。
 */
export const PermissionDecisionEvent = z.object({
  v: v1,
  type: z.literal("permission_decision"),
  ts,
  sessionId,
  callId: z.string().min(1),
  tool: z.string().min(1),
  decision: z.enum(["allow", "deny", "ask-allowed", "ask-denied"]),
  scope: z.enum(["once", "session", "project"]).optional(),
  detail: z.string().optional(),
});

/** 单轮步数到顶（防失控保护）：历史保留，用户输入「继续」可接着做 */
export const RunLimitReachedEvent = z.object({
  v: v1,
  type: z.literal("run_limit_reached"),
  ts,
  sessionId,
  maxTurns: z.number().int().positive(),
});

/** LLM 调用失败（流中断/鉴权错/模型不存在等）：界面必须可见，绝不能静默吞掉 */
export const LlmErrorEvent = z.object({
  v: v1,
  type: z.literal("llm_error"),
  ts,
  sessionId,
  error: z.string().min(1),
});

export const SessionEvent = z.discriminatedUnion("type", [
  SessionStartEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  ToolCallEvent,
  ToolResultEvent,
  CompactionSummaryEvent,
  TodoUpdateEvent,
  SkillUsedEvent,
  SessionEndEvent,
  PermissionDecisionEvent,
  LlmErrorEvent,
  RunLimitReachedEvent,
]);

export type SessionEvent = z.infer<typeof SessionEvent>;
export type SessionEventMap = {
  [K in SessionEvent["type"]]: Extract<SessionEvent, { type: K }>;
};

/** 会话事件落盘端口：core 零 IO（§0 核心纪律），实现由 runtime（JSONL）/ 测试（内存）注入 */
export interface SessionSink {
  append(event: SessionEvent): void | Promise<void>;
}

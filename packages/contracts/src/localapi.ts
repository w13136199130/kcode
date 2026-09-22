import { z } from "zod";
import { PermissionMode } from "./permissions.js";
import { SessionEvent } from "./session.js";
import { StructuredQuestion } from "./tool.js";

/** 本地 API 协议版本：客户端与守护进程不一致时拒绝连接 */
export const PROTOCOL_VERSION = 8;

const requestId = z.number().int().nonnegative();

/**
 * 客户端 → 守护进程的请求：每行一条 JSON（NDJSON），带自增 id，
 * 守护进程以同 id 的响应回复；通知类消息（event/delta/ask 等）由守护进程主动推送。
 */
export const ClientRequest = z.discriminatedUnion("method", [
  z.object({
    id: requestId,
    method: z.literal("hello"),
    token: z.string().min(1),
    protocolVersion: z.number().int().positive(),
    /** 客户端 keychain 口令设置状态：与 daemon 侧不一致 → 环境过期，客户端自动重拉 */
    passphraseSet: z.boolean().optional(),
  }),
  z.object({ id: requestId, method: z.literal("ping") }),
  z.object({
    id: requestId,
    method: z.literal("session_create"),
    cwd: z.string().min(1),
    model: z.string().min(1),
    /** 续接来源：会话 id、id 前缀或 "latest" */
    resumeFrom: z.string().optional(),
  }),
  z.object({
    id: requestId,
    method: z.literal("session_send"),
    sessionId: z.string().min(1),
    content: z.string(),
    images: z.array(z.string()).optional(),
  }),
  z.object({
    id: requestId,
    method: z.literal("session_abort"),
    sessionId: z.string().min(1),
  }),
  z.object({
    id: requestId,
    method: z.literal("session_mode"),
    sessionId: z.string().min(1),
    /** 四档权限模式（plan/default/acceptEdits/fullAccess） */
    mode: PermissionMode,
  }),
  z.object({ id: requestId, method: z.literal("session_trust"), cwd: z.string().min(1) }),
  z.object({ id: requestId, method: z.literal("commands_list"), cwd: z.string().min(1) }),
  z.object({
    id: requestId,
    method: z.literal("command_expand"),
    cwd: z.string().min(1),
    name: z.string().min(1),
    args: z.string(),
  }),
  z.object({
    id: requestId,
    method: z.literal("ask_reply"),
    callId: z.string().min(1),
    allowed: z.boolean(),
    /** session = 本会话内同工具不再询问；project = 本项目持久放行（落盘 ~/.kcode/permissions.json） */
    scope: z.enum(["once", "session", "project"]).optional(),
  }),
  z.object({
    id: requestId,
    method: z.literal("question_reply"),
    questionId: z.string().min(1),
    labels: z.array(z.string()),
  }),
  z.object({ id: requestId, method: z.literal("models_list") }),
  z.object({
    id: requestId,
    method: z.literal("session_set_model"),
    sessionId: z.string().min(1),
    model: z.string().min(1),
  }),
  z.object({ id: requestId, method: z.literal("skills_list"), sessionId: z.string().min(1) }),
  z.object({
    id: requestId,
    method: z.literal("skill_body"),
    sessionId: z.string().min(1),
    name: z.string().min(1),
  }),
  z.object({ id: requestId, method: z.literal("sessions_list") }),
  z.object({
    id: requestId,
    method: z.literal("permissions_list"),
    sessionId: z.string().min(1),
  }),
  z.object({
    id: requestId,
    method: z.literal("permissions_clear"),
    sessionId: z.string().min(1),
  }),
  z.object({
    id: requestId,
    method: z.literal("session_usage"),
    sessionId: z.string().min(1),
  }),
  z.object({
    id: requestId,
    method: z.literal("session_rewind_points"),
    sessionId: z.string().min(1),
  }),
  z.object({
    id: requestId,
    method: z.literal("session_rewind"),
    sessionId: z.string().min(1),
    /** 回退目标：会话事件流中某个 user_message 事件的序号（回退到该提问之前） */
    eventIndex: z.number().int().nonnegative(),
  }),
  z.object({ id: requestId, method: z.literal("session_compact"), sessionId: z.string().min(1) }),
  z.object({ id: requestId, method: z.literal("session_context"), sessionId: z.string().min(1) }),
  z.object({
    id: requestId,
    method: z.literal("bash_run"),
    sessionId: z.string().min(1),
    /** 用户直执行的 shell 命令（输入框 ! 前缀）：不经 LLM、不问权限（用户发起） */
    command: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
  }),
]);
export type ClientRequest = z.infer<typeof ClientRequest>;

/** 写/编辑类工具 ask 时的变更预览（TUI 渲染红绿 diff 行） */
export const AskPreviewPayload = z.object({
  path: z.string().optional(),
  diff: z.string(),
});
export type AskPreviewPayload = z.infer<typeof AskPreviewPayload>;

/** 守护进程 → 客户端：响应（带请求 id）与推送通知 */
export const ServerMessage = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("hello_ok"),
    id: requestId,
    daemonVersion: z.string(),
    /** 守护进程侧协议版本：客户端据此识别过旧 daemon 并重拉 */
    protocolVersion: z.number().int().positive(),
  }),
  z.object({ kind: z.literal("pong"), id: requestId }),
  z.object({ kind: z.literal("error"), id: requestId.optional(), message: z.string() }),
  z.object({
    kind: z.literal("session_ok"),
    id: requestId,
    sessionId: z.string(),
    /** 续接时恢复的历史消息条数（0 表示全新会话） */
    resumedMessages: z.number().int().nonnegative(),
  }),
  /** 请求已受理（如消息已进入会话队列，完成以 run_done 为准） */
  z.object({ kind: z.literal("accepted"), id: requestId }),
  z.object({
    kind: z.literal("commands"),
    id: requestId,
    commands: z.array(z.object({ name: z.string(), source: z.enum(["project", "user"]) })),
  }),
  z.object({ kind: z.literal("command_expanded"), id: requestId, template: z.string().nullable() }),
  /** 可用模型（/model）：默认引用 + providers 清单 */
  z.object({
    kind: z.literal("models"),
    id: requestId,
    default: z.string().optional(),
    providers: z.array(z.string()),
  }),
  /** 会话内已装载技能（/skills） */
  z.object({
    kind: z.literal("skills"),
    id: requestId,
    skills: z.array(z.object({ name: z.string(), description: z.string(), source: z.string() })),
  }),
  /** 技能正文（/skill 手动注入前取回） */
  z.object({ kind: z.literal("skill_body_ok"), id: requestId, body: z.string().nullable() }),
  /** 最近会话（/sessions） */
  z.object({
    kind: z.literal("sessions"),
    id: requestId,
    sessions: z.array(
      z.object({ sessionId: z.string(), preview: z.string(), turns: z.number().int() }),
    ),
  }),
  /** 本项目持久放行的工具名清单（/permissions） */
  z.object({
    kind: z.literal("permissions"),
    id: requestId,
    patterns: z.array(z.string()),
  }),
  /** 会话累计用量（/cost）：含 resume 续接的历史用量 */
  z.object({
    kind: z.literal("usage"),
    id: requestId,
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    calls: z.number().int().nonnegative(),
  }),
  /** /rewind 回退点清单（每个 user_message 一项） */
  z.object({
    kind: z.literal("rewind_points"),
    id: requestId,
    points: z.array(
      z.object({
        eventIndex: z.number().int().nonnegative(),
        preview: z.string(),
        ts: z.number(),
        fileChanges: z.number().int().nonnegative(),
      }),
    ),
  }),
  /** /rewind 执行结果 */
  z.object({
    kind: z.literal("rewind_ok"),
    id: requestId,
    restoredFiles: z.number().int().nonnegative(),
    droppedEvents: z.number().int().nonnegative(),
  }),
  /** /compact 手动压缩结果（dropped=0 表示历史过短未触发） */
  z.object({
    kind: z.literal("compact_ok"),
    id: requestId,
    dropped: z.number().int().nonnegative(),
    summaryChars: z.number().int().nonnegative(),
  }),
  /** !命令 直执行结果（仅显示，不进模型上下文） */
  z.object({
    kind: z.literal("bash_result"),
    id: requestId,
    ok: z.boolean(),
    output: z.string(),
    error: z.string().optional(),
    durationMs: z.number().int().nonnegative(),
  }),
  /** /context 上下文占用 */
  z.object({
    kind: z.literal("context_info"),
    id: requestId,
    model: z.string(),
    contextWindow: z.number().int().positive(),
    historyTokens: z.number().int().nonnegative(),
    historyBudget: z.number().int().positive(),
    systemTokens: z.number().int().nonnegative(),
    pinnedAnchor: z.boolean(),
  }),
  z.object({ kind: z.literal("event"), sessionId: z.string(), event: SessionEvent }),
  z.object({
    kind: z.literal("delta"),
    sessionId: z.string(),
    text: z.string(),
    /** 增量通道：text 正文 / reasoning 思考过程（缺省 text，向后兼容） */
    channel: z.enum(["text", "reasoning"]).optional(),
  }),
  z.object({ kind: z.literal("notice"), message: z.string() }),
  z.object({
    kind: z.literal("ask"),
    callId: z.string(),
    tool: z.string(),
    args: z.unknown(),
    preview: AskPreviewPayload.optional(),
  }),
  z.object({ kind: z.literal("question"), questionId: z.string(), question: StructuredQuestion }),
  /** 计划批准载荷（plan_submit 工具触发）：plan 为计划全文，界面以 Markdown 渲染后出批准菜单 */
  z.object({
    kind: z.literal("plan_question"),
    questionId: z.string(),
    question: StructuredQuestion,
    plan: z.string(),
  }),
  z.object({
    kind: z.literal("run_done"),
    sessionId: z.string(),
    turns: z.number().int(),
    toolCalls: z.number().int(),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

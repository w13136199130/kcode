import { z } from "zod";
import { PermissionMode } from "./permissions.js";
import { SessionEvent } from "./session.js";
import { StructuredQuestion } from "./tool.js";

/** 本地 API 协议版本：客户端与守护进程不一致时拒绝连接 */
export const PROTOCOL_VERSION = 3;

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
    /** session = 本会话内同工具不再询问（会话级放行） */
    scope: z.enum(["once", "session"]).optional(),
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
  z.object({
    kind: z.literal("run_done"),
    sessionId: z.string(),
    turns: z.number().int(),
    toolCalls: z.number().int(),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

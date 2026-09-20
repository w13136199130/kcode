import { z } from "zod";
import { SessionEvent } from "./session.js";
import { StructuredQuestion } from "./tool.js";

/** 本地 API 协议版本：客户端与守护进程不一致时拒绝连接 */
export const PROTOCOL_VERSION = 2;

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
    method: z.literal("session_plan"),
    sessionId: z.string().min(1),
    on: z.boolean(),
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
  }),
  z.object({
    id: requestId,
    method: z.literal("question_reply"),
    questionId: z.string().min(1),
    labels: z.array(z.string()),
  }),
]);
export type ClientRequest = z.infer<typeof ClientRequest>;

/** 守护进程 → 客户端：响应（带请求 id）与推送通知 */
export const ServerMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hello_ok"), id: requestId, daemonVersion: z.string() }),
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
  z.object({ kind: z.literal("event"), sessionId: z.string(), event: SessionEvent }),
  z.object({ kind: z.literal("delta"), sessionId: z.string(), text: z.string() }),
  z.object({ kind: z.literal("notice"), message: z.string() }),
  z.object({ kind: z.literal("ask"), callId: z.string(), tool: z.string(), args: z.unknown() }),
  z.object({ kind: z.literal("question"), questionId: z.string(), question: StructuredQuestion }),
  z.object({
    kind: z.literal("run_done"),
    sessionId: z.string(),
    turns: z.number().int(),
    toolCalls: z.number().int(),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

import { z } from "zod";

/** daemon 本地 API 消息（UDS/named pipe 承载，§5.6.2；P3 落地，P0 定型最小集） */

export const PROTOCOL_VERSION = 1;

export const AttachRequest = z.object({
  method: z.literal("attach"),
  token: z.string().min(1),
  protocolVersion: z.number().int().positive(),
});

export const SubscribeRequest = z.object({
  method: z.literal("subscribe"),
  sessionId: z.string().min(1),
});

export const SendRequest = z.object({
  method: z.literal("send"),
  sessionId: z.string().min(1),
  content: z.string(),
});

export const LocalApiRequest = z.discriminatedUnion("method", [
  AttachRequest,
  SubscribeRequest,
  SendRequest,
]);
export type LocalApiRequest = z.infer<typeof LocalApiRequest>;

export const LocalApiResponse = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
export type LocalApiResponse = z.infer<typeof LocalApiResponse>;

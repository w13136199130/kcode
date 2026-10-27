import { z } from "zod";
import type { PermissionAnswer, StructuredQuestion } from "./tool.js";
import { ProtocolHello } from "./protocol.js";

/**
 * 宿主进程协议词汇表（N3-1，在 N1-2 信封之上定义 method/event）：
 * - 帧 = JSON-Line（stdout 只跑 RPC，stderr 归诊断日志）；请求带 id，响应回带同 id（commandId 幂等）；
 * - 排空权威在宿主（注 A）：session/submit 只投递，宿主侧排队/预约/执行/取下一条；
 * - ask 断连/超时一律结算 deny（fail-closed，注 C）；思考增量在宿主侧合帧后下发。
 */

// ---------- 客户端 → 宿主 ----------

export const SessionCreateParams = z.object({
  model: z.string().min(1),
  cwd: z.string().min(1),
  /** 续接来源：会话 id / 前缀 / "latest"（缺省开新会话） */
  resumeFrom: z.string().optional(),
  /** 新建幂等键：同 requestId 重试返回同一 sessionId */
  requestId: z.string().min(1).optional(),
  /** 在“任务”组下新建：真实 cwd/workspaceKey 仍保留，仅 UI 归入未归类 */
  ungrouped: z.boolean().optional(),
});
export type SessionCreateParams = z.infer<typeof SessionCreateParams>;

export const SessionSubmitParams = z.object({
  text: z.string().min(1),
  /** 图片绝对路径（最多 8 张）；host 原样交给 core，落盘为 user_message.images */
  images: z.array(z.string().min(1)).max(8).optional(),
  /** now/next/later（缺省 later；now/next 语义同 RuntimeCommandQueue——只保证排最前，不打断当前轮） */
  priority: z.enum(["now", "next", "later"]).optional(),
});
export type SessionSubmitParams = z.infer<typeof SessionSubmitParams>;

/** ask/request 的应答（审批）：断连/超时由宿主按 deny 结算，客户端只需在收到请求后正常应答 */
export const AskRespondParams = z.object({
  requestId: z.string().min(1),
  allowed: z.boolean(),
  scope: z.enum(["once", "session", "project"]).optional(),
});
export type AskRespondParams = z.infer<typeof AskRespondParams>;

export const QuestionRespondParams = z.object({
  requestId: z.string().min(1),
  labels: z.array(z.string()),
});
export type QuestionRespondParams = z.infer<typeof QuestionRespondParams>;

/** 计划批准应答：approved 切执行 / revise 继续研究 / abandon 放弃 */
export const PlanRespondParams = z.object({
  requestId: z.string().min(1),
  verdict: z.enum(["approved", "revise", "abandon"]),
});
export type PlanRespondParams = z.infer<typeof PlanRespondParams>;

/** D1-02：onboarding/设置保存 provider（key 独立经 keychain，不落 config.json） */
export const ConfigSaveParams = z.object({
  providerName: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  provider: z.unknown(), // ProviderConfig；server 侧用 contracts 的 union 再校验
  model: z.string().min(1),
  key: z
    .object({
      ref: z.string().regex(/^keychain:\/\/[a-z0-9-]+$/),
      key: z.string().min(1),
      audiences: z.array(z.string().url()).min(1),
      passphrase: z.string().optional(),
    })
    .optional(),
});
export type ConfigSaveParams = z.infer<typeof ConfigSaveParams>;

export const HostMethod =
  z.string().regex(/^[a-z/][a-z0-9/_-]*$/);
export type HostMethod = z.infer<typeof HostMethod>;

/** 客户端帧：握手后只剩请求 */
export const ClientFrame = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hello"), hello: ProtocolHello }),
  z.object({
    kind: z.literal("req"),
    id: z.string().min(1),
    method: HostMethod,
    params: z.unknown().optional(),
  }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// ---------- 宿主 → 客户端 ----------

/** 排队快照（queue/change 载荷；与 RuntimeCommandQueue.onChange 同源） */
export const QueueSnapshot = z.object({
  items: z.array(
    z.object({
      id: z.number().int().positive(),
      text: z.string(),
      priority: z.enum(["now", "next", "later"]),
    }),
  ),
});
export type QueueSnapshot = z.infer<typeof QueueSnapshot>;

/** 一轮运行的结果摘要（loop.RunSummary 的结构化形状；contracts 不反向依赖 core，按形状定义） */
export const RunSummaryShape = z.object({
  sessionId: z.string().min(1),
  turns: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  status: z.string().min(1),
});
export type RunSummaryShape = z.infer<typeof RunSummaryShape>;

/** 宿主事件（宿主 → 客户端单向通知；SessionEvent 原样转发放进 session/event） */
export const HostEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), hostId: z.string().min(1), pid: z.number().int().positive() }),
  z.object({ type: z.literal("session/created"), sessionId: z.string().min(1), epoch: z.number().int().nonnegative() }),
  z.object({ type: z.literal("session/event"), event: z.unknown() }),
  /** D2-04：host 生成的写/编辑真实 preview（与 ask/request 同源；工具卡也可用） */
  z.object({
    type: z.literal("tool/preview"),
    callId: z.string().min(1),
    preview: z.object({ path: z.string().optional(), diff: z.string() }),
  }),
  z.object({ type: z.literal("session/summary"), summary: RunSummaryShape }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  z.object({ type: z.literal("queue/change"), snapshot: QueueSnapshot }),
  z.object({
    type: z.literal("ask/request"),
    requestId: z.string().min(1),
    tool: z.string().min(1),
    args: z.unknown(),
    preview: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("question/request"),
    requestId: z.string().min(1),
    question: z.custom<StructuredQuestion>(() => true),
  }),
  z.object({
    type: z.literal("plan/request"),
    requestId: z.string().min(1),
    plan: z.string(),
  }),
  /** 超时/中断：客户端据此关闭已过期的审批/计划面板 */
  z.object({ type: z.literal("ask/cancelled"), requestId: z.string().min(1) }),
  z.object({ type: z.literal("plan/cancelled"), requestId: z.string().min(1) }),
  z.object({ type: z.literal("notice"), message: z.string() }),
  /** 会话索引变更（新建/删除/恢复/归档/重命名）：多窗口侧栏据此刷新。 */
  z.object({ type: z.literal("sessions/changed"), reason: z.string() }),
  z.object({ type: z.literal("host/closing"), reason: z.string() }),
]);
export type HostEvent = z.infer<typeof HostEvent>;

export const HostFrame = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hello"), hello: ProtocolHello }),
  z.object({
    kind: z.literal("res"),
    id: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal("ev"), event: HostEvent }),
]);
export type HostFrame = z.infer<typeof HostFrame>;

/** key 录入（Login 向导 / key 子命令）——key 明文只在宿主进程内停留（N3-2 注 E） */
export const PlatformSaveKeyParams = z.object({
  ref: z.string().min(1),
  key: z.string().min(1),
  audiences: z.array(z.string()),
  /** 指定口令时走口令加密；缺省走系统存储（DPAPI）——不支持时宿主报错 */
  passphrase: z.string().optional(),
});
export type PlatformSaveKeyParams = z.infer<typeof PlatformSaveKeyParams>;

export const PlatformProbeResult = z.object({
  available: z.boolean(),
});
export type PlatformProbeResult = z.infer<typeof PlatformProbeResult>;

// ---------- 方法返回形状（result 的 zod，供宿主实现与客户端解析共用） ----------

export const SessionCreateResult = z.object({
  sessionId: z.string().min(1),
  /** 本宿主租约的 logEpoch（重启即 +1，注 B） */
  epoch: z.number().int().nonnegative(),
});
export type SessionCreateResult = z.infer<typeof SessionCreateResult>;

export const SessionSubmitResult = z.object({
  queued: z.boolean(),
  position: z.number().int().positive().optional(),
});
export type SessionSubmitResult = z.infer<typeof SessionSubmitResult>;

export const SessionsListResult = z.object({
  sessions: z.array(
    z.object({ sessionId: z.string(), preview: z.string(), turns: z.number().int().nonnegative() }),
  ),
});
export type SessionsListResult = z.infer<typeof SessionsListResult>;

/** 审批应答的规范化形状（ask/response 与宿主内 PermissionAnswer 的桥） */
export const normalizeAskAnswer = (allowed: boolean, scope?: "once" | "session" | "project"): PermissionAnswer => {
  if (!allowed) return { allowed: false };
  return scope === undefined ? { allowed: true } : { allowed: true, scope };
};

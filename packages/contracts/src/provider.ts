import { z } from "zod";

/**
 * ProviderConfig 双作用域（§5.7 防 API key 外泄的第一层）：
 * providers 定义（type/baseURL/keyRef）只存在于用户级配置；
 * 项目级是独立小 schema——根本没有 providers 字段，出现即 parse error，
 * "恶意仓库改 baseURL 指向攻击者"在 schema 层不可表达。
 * 第二层防御见 KeychainEntry（key 受众绑定）。
 */

const providerName = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
/** 模型引用：裸 provider 名或 provider/model 形式（§5.7：`model: "deepseek/chat"` 解析路由） */
const modelRef = z.string().regex(/^[a-z0-9][a-z0-9-_.]{0,63}(?:\/[a-z0-9][a-z0-9-_.]{0,63})?$/);
const keyRef = z.string().regex(/^keychain:\/\/[a-z0-9-]+$/);

export const GatewayProviderConfig = z.object({ type: z.literal("gateway") });

export const OpenAIProviderConfig = z.object({
  type: z.literal("openai"),
  keyRef,
});

export const OpenAICompatibleProviderConfig = z.object({
  type: z.literal("openai-compatible"),
  baseURL: z.string().url(),
  keyRef: keyRef.optional(),
});

export const ProviderConfig = z.discriminatedUnion("type", [
  GatewayProviderConfig,
  OpenAIProviderConfig,
  OpenAICompatibleProviderConfig,
]);
export type ProviderConfig = z.infer<typeof ProviderConfig>;

/** 用户级 models 配置（~/.kcode/config.json）：唯一允许定义 providers 的作用域 */
export const UserModelsConfig = z.object({
  default: modelRef.optional(),
  providers: z.record(providerName, ProviderConfig),
});
export type UserModelsConfig = z.infer<typeof UserModelsConfig>;

/** 项目级 models 配置（.kcode/config.json）：strict——未知键（含 providers）直接报错 */
export const ProjectModelsConfig = z
  .object({
    default: modelRef.optional(),
  })
  .strict();
export type ProjectModelsConfig = z.infer<typeof ProjectModelsConfig>;

export const UserConfigFile = z
  .object({
    models: UserModelsConfig.optional(),
  })
  .strict();

export const ProjectConfigFile = z
  .object({
    models: ProjectModelsConfig.optional(),
  })
  .strict();

/** keychain 受众绑定（§5.7 第二层防御，同类产品少有）：key 只允许发往 audiences 内端点 */
export interface KeychainEntry {
  ref: string;
  key: string;
  audiences: string[];
}

/** LLM 端口：core 消费，platform/providers 实现（路由到 Vercel AI SDK） */
export interface ToolCallPart {
  callId: string;
  tool: string;
  args: unknown;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** assistant 消息携带的工具调用记录（OpenAI 兼容端点要求 tool 结果前有对应 tool_calls） */
  toolCalls?: ToolCallPart[];
  toolCallId?: string;
  name?: string;
  /** 用户消息附图（本地文件路径；provider 层转 image parts，§1.1 B 域多模态输入） */
  images?: string[];
}

export interface LLMToolSpec {
  name: string;
  description: string;
  parameters: unknown; // JSON Schema
}

export interface LLMRequest {
  model: string;
  messages: ChatMessage[];
  tools?: LLMToolSpec[];
  /** 中断信号（Esc abort）：provider 应传给底层 SDK 立即停止流式 */
  signal?: AbortSignal;
}

/** 单次 LLM 调用的 token 用量（OpenAI 兼容端点经 stream_options.include_usage 在流末返回；端点不支持则缺省） */
export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * LLM 流式块：reasoning 为思考过程增量（DeepSeek/GLM 的 reasoning_content），
 * 瞬态推送 TUI；不回传 API（DeepSeek 契约要求），落盘走 assistant_message.reasoning。
 * end.usage 携带本次调用的用量（端点返回了才出现）。
 */
export type LLMChunk =
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; callId: string; tool: string; args: unknown }
  | { type: "end"; reason: "stop" | "tool_use" | "error"; error?: string; usage?: LLMUsage };

export interface LLMProvider {
  id: string;
  stream(req: LLMRequest): AsyncIterable<LLMChunk>;
}

/** 历史摘要器的输入：待压缩的历史消息（按时间先后排列） */
export interface SummarizerInput {
  messages: ChatMessage[];
}

/**
 * 历史摘要器端口：会话历史超出 token 预算时，把较早的对话压缩为摘要文本。
 * 由组合层注入实现（本地/便宜模型均可），核心层不感知其实现方式。
 */
export interface SummarizerPort {
  summarize(input: SummarizerInput): Promise<string>;
}

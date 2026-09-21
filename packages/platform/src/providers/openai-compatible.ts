import { readFileSync } from "node:fs";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  jsonSchema,
  streamText,
  type CoreMessage,
  type ImagePart,
  type TextPart,
  type ToolCallPart,
  type ToolResultPart,
} from "ai";
import type { ChatMessage, LLMChunk, LLMProvider, LLMRequest } from "@kcode/contracts";

export type FetchLike = typeof globalThis.fetch;

export interface OpenAICompatibleOptions {
  baseURL: string;
  apiKey?: string;
  model: string;
  /** 测试注入；生产由 daemon 传入全局 fetch */
  fetch?: FetchLike;
}

/**
 * OpenAI 兼容端点 LLMProvider（§5.7 三模式之一）
 * 覆盖 DeepSeek / GLM / one-api 中转 / Ollama / vLLM；网关模式 P5 另行接入。
 * 用 @ai-sdk/openai-compatible（而非 @ai-sdk/openai）：它解析 DeepSeek/GLM 风格的
 * delta.reasoning_content → reasoning 流事件，思考过程才能透传到 LLMChunk。
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  readonly #options: OpenAICompatibleOptions;

  constructor(id: string, options: OpenAICompatibleOptions) {
    this.id = id;
    this.#options = options;
  }

  async *stream(req: LLMRequest): AsyncIterable<LLMChunk> {
    const client = createOpenAICompatible({
      name: "kcode-openai-compatible",
      baseURL: this.#options.baseURL,
      // 无 key 端点（本地 Ollama）占位，服务端忽略
      apiKey: this.#options.apiKey ?? "not-set",
      fetch: this.#options.fetch,
    });
    // 动态工具 schema 来自 contracts（运行时 JSON Schema），用 jsonSchema() 包裹后交给 SDK
    const tools =
      req.tools !== undefined && req.tools.length > 0
        ? Object.fromEntries(
            req.tools.map((t) => [
              t.name,
              { description: t.description, parameters: jsonSchema(t.parameters) },
            ]),
          )
        : undefined;

    const result = streamText({
      model: client(this.#options.model),
      messages: toCoreMessages(req.messages),
      tools,
      abortSignal: req.signal,
    });

    let ended = false;
    for await (const part of result.fullStream) {
      if (part.type === "reasoning") {
        yield { type: "reasoning", text: part.textDelta };
      } else if (part.type === "text-delta") {
        yield { type: "text", text: part.textDelta };
      } else if (part.type === "tool-call") {
        yield { type: "tool_call", callId: part.toolCallId, tool: part.toolName, args: part.args };
      } else if (part.type === "error") {
        ended = true;
        yield {
          type: "end",
          reason: "error",
          error: part.error instanceof Error ? part.error.message : String(part.error),
        };
      } else if (part.type === "finish" && !ended) {
        ended = true;
        // SDK 已发 stream_options.include_usage：支持的端点在流末回报用量（v4 字段名 prompt/completionTokens）
        const usage = part.usage;
        yield {
          type: "end",
          reason: part.finishReason === "tool-calls" ? "tool_use" : "stop",
          ...(usage?.promptTokens !== undefined || usage?.completionTokens !== undefined
            ? {
                usage: {
                  inputTokens: usage?.promptTokens ?? 0,
                  outputTokens: usage?.completionTokens ?? 0,
                },
              }
            : {}),
        };
      }
    }
    if (!ended) {
      yield { type: "end", reason: "stop" };
    }
  }
}

/**
 * ChatMessage[] → AI SDK CoreMessage[]：
 * assistant 的 toolCalls 展开为 tool-call parts；连续 tool 消息合并为一条 tool-result 集合。
 */
export function toCoreMessages(messages: ChatMessage[]): CoreMessage[] {
  const out: CoreMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: m.content });
    } else if (m.role === "user") {
      if (m.images !== undefined && m.images.length > 0) {
        // 多模态输入（§1.1 B 域）：本地图片读取为 image parts
        const parts: Array<TextPart | ImagePart> = [{ type: "text", text: m.content }];
        for (const imagePath of m.images) {
          try {
            parts.push({ type: "image", image: readFileSync(imagePath) });
          } catch (err) {
            throw new Error(
              `读取附图失败 ${imagePath}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        out.push({ role: "user", content: parts });
      } else {
        out.push({ role: "user", content: m.content });
      }
    } else if (m.role === "assistant") {
      const content: Array<TextPart | ToolCallPart> = [];
      if (m.content !== "") {
        content.push({ type: "text", text: m.content });
      }
      for (const call of m.toolCalls ?? []) {
        content.push({
          type: "tool-call",
          toolCallId: call.callId,
          toolName: call.tool,
          args: call.args,
        });
      }
      out.push({
        role: "assistant",
        content: content.length > 0 ? content : [{ type: "text", text: "" }],
      });
    } else {
      const part: ToolResultPart = {
        type: "tool-result",
        toolCallId: m.toolCallId ?? "",
        toolName: m.name ?? "",
        result: m.content,
      };
      const last = out[out.length - 1];
      if (last !== undefined && last.role === "tool") {
        (last.content as ToolResultPart[]).push(part);
      } else {
        out.push({ role: "tool", content: [part] });
      }
    }
  }
  return out;
}

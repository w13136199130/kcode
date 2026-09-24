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
import { computeBackoffMs, isRetryableLlmError, sleepWithSignal, type LlmRetryOptions } from "./retry.js";

export type FetchLike = typeof globalThis.fetch;

export interface OpenAICompatibleOptions {
  baseURL: string;
  apiKey?: string;
  model: string;
  /** 测试注入；生产由组合层传入全局 fetch */
  fetch?: FetchLike;
  /** 瞬态失败重试（429/网络抖动；清洁重试——仅未吐内容时重放）；maxRetries=0 关闭 */
  retry?: LlmRetryOptions;
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
    // 每次尝试新客户端（连接不复用失败状态）；tools 与消息在循环内重建，避免复用已被消费的流
    const maxRetries = this.#options.retry?.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
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
        // 关闭 SDK 内置重试（默认 2 次带自身退避）：重试策略统一由外层 retry.ts 持有，
        // 避免两层重试相乘与不可观测的等待
        maxRetries: 0,
      });

      let ended = false;
      // 清洁重试哨兵：本次尝试已向下游吐出内容后不再重试（半截内容无法回收）
      let yielded = false;
      let failed: unknown;
      try {
        for await (const part of result.fullStream) {
          if (part.type === "reasoning") {
            yielded = true;
            yield { type: "reasoning", text: part.textDelta };
          } else if (part.type === "text-delta") {
            yielded = true;
            yield { type: "text", text: part.textDelta };
          } else if (part.type === "tool-call") {
            yielded = true;
            yield { type: "tool_call", callId: part.toolCallId, tool: part.toolName, args: part.args };
          } else if (part.type === "error") {
            // finish 已到达后的迟到错误不再当失败（避免双 end chunk）
            if (!ended) {
              failed = part.error;
              break;
            }
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
      } catch (err) {
        if (!yielded && attempt < maxRetries && !req.signal?.aborted && isRetryableLlmError(err)) {
          const delayMs = computeBackoffMs(attempt, err, this.#options.retry);
          this.#options.retry?.onRetry?.({ attempt: attempt + 1, delayMs, reason: err instanceof Error ? err.message : String(err) });
          await (this.#options.retry?.sleep ?? sleepWithSignal)(delayMs, req.signal);
          continue;
        }
        throw err;
      }
      if (failed === undefined) {
        if (!ended) {
          yield { type: "end", reason: "stop" };
        }
        return;
      }
      // 错误 part：未吐内容且可重试 → 退避后重放（AI SDK 的 APICallError 带 statusCode，分类准确）
      if (!yielded && attempt < maxRetries && !req.signal?.aborted && isRetryableLlmError(failed)) {
        const delayMs = computeBackoffMs(attempt, failed, this.#options.retry);
        this.#options.retry?.onRetry?.({
          attempt: attempt + 1,
          delayMs,
          reason: failed instanceof Error ? failed.message : String(failed),
        });
        await (this.#options.retry?.sleep ?? sleepWithSignal)(delayMs, req.signal);
        continue;
      }
      yield {
        type: "end",
        reason: "error",
        error: failed instanceof Error ? failed.message : String(failed),
      };
      return;
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

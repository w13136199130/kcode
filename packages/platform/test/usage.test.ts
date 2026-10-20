import { describe, expect, it } from "vitest";
import { normalizeUsage } from "../src/index.js";

/**
 * 3-21：usage 预留字段接线——不同厂商/不同 SDK 形态归一化，
 * 未知厂商缺字段时降级为仅输入/输出，不制造假 0。
 */
describe("normalizeUsage（厂商 usage 归一化）", () => {
  it("AI SDK v4 形态：prompt/completionTokens + Details", () => {
    expect(
      normalizeUsage({
        promptTokens: 100,
        completionTokens: 20,
        promptTokensDetails: { cachedTokens: 60 },
        completionTokensDetails: { reasoningTokens: 5 },
      }),
    ).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, reasoningTokens: 5 });
  });

  it("OpenAI 原始 snake_case 形态", () => {
    expect(
      normalizeUsage({
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 8 },
        completion_tokens_details: { reasoning_tokens: 1 },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 8, reasoningTokens: 1 });
  });

  it("Anthropic 缓存字段；未知字段忽略", () => {
    expect(
      normalizeUsage({
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 3,
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 3 });
  });

  it("无 usage / 未知形态返回 undefined（降级显示）", () => {
    expect(normalizeUsage(undefined)).toBeUndefined();
    expect(normalizeUsage({ foo: 1 })).toBeUndefined();
  });
});

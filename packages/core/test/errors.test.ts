import { describe, expect, it } from "vitest";
import { classifyLlmError, isContextOverflowError } from "../src/index.js";

describe("3-20 上下文溢出识别", () => {
  it("常见端点措辞命中", () => {
    for (const msg of [
      "400 This model's maximum context length is 65536 tokens",
      "context_length_exceeded",
      "The prompt is too long for this model",
      "too many tokens in request",
      "上下文超过上限",
    ]) {
      expect(isContextOverflowError(msg)).toBe(true);
    }
  });

  it("普通限流/网络错误不误判", () => {
    for (const msg of ["429 rate limit exceeded", "fetch failed", "500 internal server error"]) {
      expect(isContextOverflowError(msg)).toBe(false);
    }
  });
});

describe("S2-3 classifyLlmError（发射侧权威分类）", () => {
  it.each([
    ["Error code 1112 - 余额不足", "quota"],
    ["You exceeded your current quota", "quota"],
    ["HTTP 402 Payment Required", "quota"],
    ["context length exceeded", "context_overflow"],
    ["Invalid API key provided", "auth"],
    ["429 Too Many Requests", "rate_limit"],
    ["fetch failed: ECONNREFUSED 127.0.0.1:1", "network"],
    ["something completely different", "unknown"],
  ])("%s -> %s", (message, expected) => {
    expect(classifyLlmError(message)).toBe(expected);
  });
});

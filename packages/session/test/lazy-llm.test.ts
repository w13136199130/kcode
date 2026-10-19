import { describe, expect, it } from "vitest";
import type { LLMChunk, LLMProvider, LLMRequest } from "@kcode/contracts";
import { LazyLlmProvider } from "../src/lazy-llm.js";

class FakeLlm implements LLMProvider {
  id = "fake";
  async *stream(_req: LLMRequest): AsyncIterable<LLMChunk> {
    yield { type: "text", text: "ok" };
    yield { type: "end", reason: "stop" };
  }
}

async function collect(provider: LazyLlmProvider): Promise<LLMChunk[]> {
  const chunks: LLMChunk[] = [];
  for await (const chunk of provider.stream({ model: "m", messages: [] })) chunks.push(chunk);
  return chunks;
}

describe("LazyLlmProvider（2-02）", () => {
  it("compose 不解析；首次 stream 才 resolve，并缓存同一实例", async () => {
    let calls = 0;
    const lazy = new LazyLlmProvider(async () => {
      calls += 1;
      return new FakeLlm();
    });
    expect(calls).toBe(0);
    expect(lazy.id).toBe("lazy");
    expect(lazy.resolved).toBeNull();

    const chunks = await collect(lazy);
    expect(chunks.map((c) => c.type)).toEqual(["text", "end"]);
    expect(calls).toBe(1);
    expect(lazy.id).toBe("fake");
    expect(lazy.resolved).not.toBeNull();

    await collect(lazy);
    expect(calls).toBe(1);
  });

  it("解析失败不缓存：登录修复后同一会话重试可成功", async () => {
    let fail = true;
    let calls = 0;
    const lazy = new LazyLlmProvider(async () => {
      calls += 1;
      if (fail) throw new Error("未配置模型");
      return new FakeLlm();
    });

    await expect(collect(lazy)).rejects.toThrow("未配置模型");
    expect(calls).toBe(1);
    expect(lazy.resolved).toBeNull();

    fail = false;
    await expect(collect(lazy)).resolves.toHaveLength(2);
    expect(calls).toBe(2);
    expect(lazy.id).toBe("fake");
  });

  it("listModels 同样延迟；provider 不支持时返回空清单", async () => {
    let calls = 0;
    const lazy = new LazyLlmProvider(async () => {
      calls += 1;
      return new FakeLlm();
    });
    expect(calls).toBe(0);
    await expect(lazy.listModels()).resolves.toEqual([]);
    expect(calls).toBe(1);
  });
});

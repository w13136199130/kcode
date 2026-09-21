import { describe, expect, it } from "vitest";
import type { LLMChunk } from "@kcode/contracts";
import {
  OpenAICompatibleProvider,
  computeBackoffMs,
  isRetryableLlmError,
  sleepWithSignal,
  type FetchLike,
} from "../src/providers/index.js";

function sse(payloads: unknown[], status = 200): Response {
  const body =
    status === 200
      ? payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join("") + "data: [DONE]\n\n"
      : JSON.stringify(payloads);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" } });
}

const TEXT_SSE = [{ choices: [{ index: 0, delta: { content: "ok" } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }];

/** 带调用计数的 fetch mock */
interface CountingFetch extends FetchLike {
  calls: number;
}

/** 前缀失败序列 + 最终成功 SSE 的 fetch；记录每次调用 */
function flakyFetch(failures: Response[], cause?: Error): CountingFetch {
  let calls = 0;
  const fn = async (): Promise<Response> => {
    calls++;
    const failure = failures.shift();
    if (failure !== undefined) {
      if (cause !== undefined) {
        throw cause;
      }
      return failure;
    }
    return sse(TEXT_SSE);
  };
  const counting = fn as unknown as CountingFetch;
  Object.defineProperty(counting, "calls", { get: () => calls, configurable: true });
  return counting;
}

function providerWith(fetchImpl: FetchLike, maxRetries = 3): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider("test", {
    baseURL: "https://api.test/v1",
    apiKey: "sk",
    model: "chat",
    fetch: fetchImpl,
    retry: { maxRetries, baseDelayMs: 1, sleep: async () => {} },
  });
}

async function collect(iterable: AsyncIterable<LLMChunk>): Promise<LLMChunk[]> {
  const chunks: LLMChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

const request = { model: "chat", messages: [{ role: "user" as const, content: "hi" }] };

describe("LLM 瞬态失败重试（清洁重试策略）", () => {
  it("429 后重试成功：最终拿到正文，fetch 调用两次", async () => {
    const fetch = flakyFetch([new Response("rate limited", { status: 429 })]);
    const chunks = await collect(providerWith(fetch).stream(request));
    const text = chunks.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
    expect(text).toBe("ok");
    expect(chunks.at(-1)).toMatchObject({ type: "end", reason: "stop" });
    expect(fetch.calls).toBe(2);
  });

  it("网络错误（fetch failed / ECONNRESET）后重试成功", async () => {
    const cause = Object.assign(new Error("fetch failed"), {}) as Error & { cause?: unknown };
    cause.cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    // 占位 Response：flakyFetch 以 failures 非空判定本次抛错
    const fetch = flakyFetch([new Response("", { status: 429 })], cause);
    const chunks = await collect(providerWith(fetch).stream(request));
    expect(chunks.at(-1)).toMatchObject({ type: "end", reason: "stop" });
    expect(fetch.calls).toBe(2);
  });

  it("鉴权失败（401）不重试：一次调用即报错", async () => {
    const fetch = flakyFetch([new Response("unauthorized", { status: 401 })]);
    const chunks = await collect(providerWith(fetch).stream(request));
    expect(chunks.at(-1)).toMatchObject({ type: "end", reason: "error" });
    expect(fetch.calls).toBe(1);
  });

  it("重试耗尽：maxRetries 次后退避放弃，报 end error", async () => {
    const fetch = flakyFetch([new Response("e1", { status: 429 }), new Response("e2", { status: 429 }), new Response("e3", { status: 429 })]);
    const chunks = await collect(providerWith(fetch, 2).stream(request));
    expect(chunks.at(-1)).toMatchObject({ type: "end", reason: "error" });
    expect(fetch.calls).toBe(3); // 1 次原始 + 2 次重试
  });

  it("已吐内容后的中途失败不重试（清洁重试哨兵）", async () => {
    // 流：先出一截正文（等它被读到），然后 socket 错误——迭代中途错误按既有语义抛出
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "par" } }] })}\n\n`));
        setTimeout(() => controller.error(new Error("socket hang up")), 50);
      },
    });
    let calls = 0;
    const fetchOnce = async (): Promise<Response> => {
      calls++;
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const provider = providerWith(fetchOnce);
    const chunks: LLMChunk[] = [];
    await expect(async () => {
      for await (const chunk of provider.stream(request)) {
        chunks.push(chunk);
      }
    }).rejects.toThrow("socket hang up");
    const text = chunks.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
    expect(text).toBe("par"); // 半截内容已如实透传给下游
    expect(calls).toBe(1); // 已吐内容 → 不重试
  }, 15_000);

  it("onRetry 回调携带尝试序号与延迟", async () => {
    const retries: { attempt: number; delayMs: number }[] = [];
    const fetch = flakyFetch([new Response("x", { status: 503 })]);
    const provider = new OpenAICompatibleProvider("test", {
      baseURL: "https://api.test/v1",
      model: "chat",
      fetch,
      retry: {
        maxRetries: 3,
        baseDelayMs: 10,
        sleep: async () => {},
        onRetry: (info) => retries.push({ attempt: info.attempt, delayMs: info.delayMs }),
      },
    });
    await collect(provider.stream(request));
    expect(retries).toHaveLength(1);
    expect(retries[0]!.attempt).toBe(1);
    expect(retries[0]!.delayMs).toBeGreaterThanOrEqual(10);
  });
});

describe("isRetryableLlmError（分类）", () => {
  it("状态码：408/429/5xx 可重试，其余 4xx 与 200 不可", () => {
    expect(isRetryableLlmError(Object.assign(new Error("x"), { statusCode: 429 }))).toBe(true);
    expect(isRetryableLlmError(Object.assign(new Error("x"), { statusCode: 408 }))).toBe(true);
    expect(isRetryableLlmError(Object.assign(new Error("x"), { statusCode: 503 }))).toBe(true);
    expect(isRetryableLlmError(Object.assign(new Error("x"), { statusCode: 401 }))).toBe(false);
    expect(isRetryableLlmError(Object.assign(new Error("x"), { statusCode: 400 }))).toBe(false);
  });

  it("cause 链上的网络错误码可重试", () => {
    const root = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const wrapped = new Error("fetch failed");
    wrapped.cause = root;
    expect(isRetryableLlmError(wrapped)).toBe(true);
  });

  it("AbortError 永不重试；确定性错误不可重试", () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    expect(isRetryableLlmError(abortErr)).toBe(false);
    expect(isRetryableLlmError(new Error("invalid request body"))).toBe(false);
  });

  it("字符串错误按消息特征判定", () => {
    expect(isRetryableLlmError("Upstream Service Unavailable")).toBe(true);
    expect(isRetryableLlmError("bad json")).toBe(false);
  });
});

describe("computeBackoffMs / sleepWithSignal", () => {
  it("Retry-After 头优先（秒转毫秒）", () => {
    const err = Object.assign(new Error("x"), { statusCode: 429, responseHeaders: { "retry-after": "2" } });
    expect(computeBackoffMs(0, err, { baseDelayMs: 100 })).toBe(2000);
  });

  it("指数退避 + [0,250) 抖动，封顶 maxDelayMs", () => {
    for (let i = 0; i < 20; i++) {
      const d0 = computeBackoffMs(0, new Error("x"), { baseDelayMs: 100, maxDelayMs: 1000 });
      expect(d0).toBeGreaterThanOrEqual(100);
      expect(d0).toBeLessThan(350);
      const d5 = computeBackoffMs(5, new Error("x"), { baseDelayMs: 100, maxDelayMs: 1000 });
      expect(d5).toBeGreaterThanOrEqual(1000);
      expect(d5).toBeLessThan(1250);
    }
  });

  it("sleepWithSignal 在 abort 时提前返回", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const p = sleepWithSignal(5000, controller.signal);
    controller.abort();
    await p;
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { LlmSummarizer } from "../src/providers/summarizer.js";

/** 构造返回固定文本流的模型提供方（不发真实网络请求） */
function makeProvider(content: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider("test:summary", {
    baseURL: "https://mock.example/v1",
    model: "chat",
    fetch: (async () => {
      const body =
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
        "data: [DONE]\n\n";
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
  });
}

describe("LlmSummarizer（历史摘要器）", () => {
  it("把历史转写交给模型并返回摘要文本", async () => {
    const summarizer = new LlmSummarizer(makeProvider("【摘要】任务完成一半。"), "chat");
    const summary = await summarizer.summarize({
      messages: [
        { role: "user", content: "修复登录页" },
        { role: "assistant", content: "已定位到 auth.ts" },
        { role: "tool", content: "文件内容…", toolCallId: "c1", name: "read" },
      ],
    });
    expect(summary).toBe("【摘要】任务完成一半。");
  });

  it("模型输出为空时返回降级占位", async () => {
    const summarizer = new LlmSummarizer(makeProvider(""), "chat");
    const summary = await summarizer.summarize({ messages: [{ role: "user", content: "q" }] });
    expect(summary).toContain("摘要生成为空");
  });
});

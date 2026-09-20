import { describe, expect, it } from "vitest";
import type { ChatMessage, LLMChunk } from "@kcode/contracts";
import { OpenAICompatibleProvider, toCoreMessages } from "../src/providers/openai-compatible.js";

function sse(payloads: unknown[]): Response {
  const body =
    payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join("") + "data: [DONE]\n\n";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** 注入式 fetch：返回脚本化 OpenAI SSE（不发真实网络请求） */
const fetchMock = (payloads: unknown[]): typeof fetch => {
  return async () => sse(payloads);
};

function makeProvider(payloads: unknown[]): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider("test:deepseek", {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    model: "chat",
    fetch: fetchMock(payloads),
  });
}

async function collect(iterable: AsyncIterable<LLMChunk>): Promise<LLMChunk[]> {
  const chunks: LLMChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("OpenAICompatibleProvider（mock fetch SSE）", () => {
  it("文本流映射为 LLMChunk", async () => {
    const provider = makeProvider([
      { choices: [{ index: 0, delta: { content: "Hel" } }] },
      { choices: [{ index: 0, delta: { content: "lo" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
    const chunks = await collect(
      provider.stream({ model: "chat", messages: [{ role: "user", content: "hi" }] }),
    );
    const text = chunks
      .filter((c): c is Extract<LLMChunk, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toBe("Hello");
    expect(chunks.at(-1)).toMatchObject({ type: "end", reason: "stop" });
  });

  it("工具调用流映射为 tool_call chunk（含分段 arguments 拼接）", async () => {
    const provider = makeProvider([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "echo", arguments: '{"msg":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] } },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const messages: ChatMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ callId: "call_1", tool: "echo", args: { msg: "hi" } }] },
      { role: "tool", content: "hi", toolCallId: "call_1", name: "echo" },
    ];
    const chunks = await collect(
      provider.stream({
        model: "chat",
        messages,
        tools: [
          {
            name: "echo",
            description: "回显",
            parameters: { type: "object", properties: { msg: { type: "string" } } },
          },
        ],
      }),
    );
    const call = chunks.find(
      (c): c is Extract<LLMChunk, { type: "tool_call" }> => c.type === "tool_call",
    );
    expect(call).toMatchObject({ callId: "call_1", tool: "echo" });
    expect(call?.args).toEqual({ msg: "hi" });
    expect(chunks.at(-1)).toMatchObject({ type: "end", reason: "tool_use" });
  });
});

describe("toCoreMessages", () => {
  it("连续 tool 消息合并为一条 tool-result 集合；assistant toolCalls 展开", () => {
    const out = toCoreMessages([
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { callId: "1", tool: "a", args: {} },
          { callId: "2", tool: "b", args: {} },
        ],
      },
      { role: "tool", content: "r1", toolCallId: "1", name: "a" },
      { role: "tool", content: "r2", toolCallId: "2", name: "b" },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]?.role).toBe("user");
    expect(out[1]?.role).toBe("assistant");
    expect(out[2]?.role).toBe("tool");
    expect(out[2]?.content).toHaveLength(2);
  });

  it("用户附图转为 text+image parts（多模态输入）", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "kcode-img-"));
    const img = join(dir, "a.png");
    await writeFile(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    try {
      const out = toCoreMessages([{ role: "user", content: "这是什么？", images: [img] }]);
      const content = out[0]?.content as Array<{ type: string; text?: string; image?: Buffer }>;
      expect(content).toHaveLength(2);
      expect(content[0]).toMatchObject({ type: "text", text: "这是什么？" });
      expect(content[1]?.type).toBe("image");
      expect(content[1]?.image?.length).toBe(7);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reasoning_content 流映射为 reasoning chunk（DeepSeek/GLM 思考过程）", async () => {
    const provider = makeProvider([
      { choices: [{ index: 0, delta: { reasoning_content: "先想" } }] },
      { choices: [{ index: 0, delta: { reasoning_content: "一想" } }] },
      { choices: [{ index: 0, delta: { content: "答案" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
    const chunks = await collect(
      provider.stream({ model: "chat", messages: [{ role: "user", content: "q" }] }),
    );
    const reasoning = chunks
      .filter((c): c is Extract<LLMChunk, { type: "reasoning" }> => c.type === "reasoning")
      .map((c) => c.text)
      .join("");
    expect(reasoning).toBe("先想一想");
    const text = chunks
      .filter((c): c is Extract<LLMChunk, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toBe("答案");
    // reasoning 先于正文
    expect(chunks[0]?.type).toBe("reasoning");
  });
});

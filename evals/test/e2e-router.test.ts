import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KeychainEntry, SessionEvent } from "@kcode/contracts";
import { UserModelsConfig } from "@kcode/contracts";
import {
  AgentLoop,
  InMemoryToolRegistry,
  MemoryAudit,
  MemorySink,
  allowAll,
  noHooks,
} from "@kcode/core";
import { createProviderRouter, type KeychainStore } from "@kcode/platform";
import { readOnlyTools } from "@kcode/tools";

class EmptyKeychain implements KeychainStore {
  async get(_ref: string): Promise<KeychainEntry | null> {
    return null;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
  async list(): Promise<string[]> {
    return [];
  }
}

function sse(payloads: unknown[]): Response {
  const body = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join("") + "data: [DONE]\n\n";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

type AssistantEvent = Extract<SessionEvent, { type: "assistant_message" }>;
type ToolResultEvent = Extract<SessionEvent, { type: "tool_result" }>;

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-e2e2-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "audience.ts"),
    "export async function resolveApiKey() {\n  // 受众绑定校验（§5.7 第二层防御）：key 只发往登记端点\n}\n",
    "utf8",
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("P1-3 端到端：配置→路由→provider→loop→真实工具→答案", () => {
  it("grep 查证后给出带文件引用的回答", async () => {
    // 无 key 的本地端点（Ollama 同款形态），fetch 注入两轮脚本：先工具调用、后文本结论
    let call = 0;
    const fetchMock: typeof fetch = async () => {
      call += 1;
      if (call === 1) {
        return sse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "c1",
                      type: "function",
                      function: { name: "grep", arguments: '{"pattern":"受众绑定"}' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]);
      }
      return sse([
        { choices: [{ index: 0, delta: { content: "受众绑定校验实现在 src/audience.ts 的 resolveApiKey。" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
    };

    const models = UserModelsConfig.parse({
      default: "mock/chat",
      providers: { mock: { type: "openai-compatible", baseURL: "http://127.0.0.1:9/v1" } },
    });
    const llm = await createProviderRouter(models, new EmptyKeychain(), { fetch: fetchMock }).resolve(
      "mock/chat",
    );

    const sink = new MemorySink();
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry(readOnlyTools),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
      },
      { sessionId: "sess_p13", model: "mock/chat", systemPrompt: "e2e", cwd: root, now: () => 0 },
    );

    await loop.run("受众绑定校验在哪实现？");

    // 工具是真的：rg 子进程在临时仓库里命中了源文件
    const grep = sink.events.find((e): e is ToolResultEvent => e.type === "tool_result");
    expect(grep?.ok).toBe(true);
    expect(grep?.output).toContain("受众绑定校验");
    // 结论引用文件
    const answer = sink.events.filter((e): e is AssistantEvent => e.type === "assistant_message");
    expect(answer.at(-1)?.content).toContain("src/audience.ts");
  });
});

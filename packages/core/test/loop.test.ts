import { describe, expect, it } from "vitest";
import type { SessionEvent, Tool, ToolDefinition } from "@kcode/contracts";
import { AgentLoop } from "../src/core/loop.js";
import {
  InMemoryToolRegistry,
  MemoryAudit,
  MemorySink,
  ScriptedLLM,
  allowAll,
  denyAll,
  noHooks,
} from "../src/testing/index.js";

type ToolResultEvent = Extract<SessionEvent, { type: "tool_result" }>;

const echoDefinition: ToolDefinition = {
  name: "echo",
  description: "回显消息",
  parameters: { type: "object", properties: { msg: { type: "string" } } },
  readOnly: true,
};

function echoTool(received: string[]): Tool {
  return {
    definition: echoDefinition,
    execute: async (input) => {
      const { msg } = input as { msg: string };
      received.push(msg);
      return { ok: true, output: msg };
    },
  };
}

describe("AgentLoop（§5.1 状态机）", () => {
  it("消息→工具→回填→结束，事件序列符合 JSONL 契约", async () => {
    const llm = new ScriptedLLM([
      {
        toolCalls: [
          { callId: "c1", tool: "echo", args: { msg: "hi" } },
          { callId: "c2", tool: "echo", args: { msg: "yo" } },
        ],
      },
      { text: "done" },
    ]);
    const sink = new MemorySink();
    const audit = new MemoryAudit();
    const received: string[] = [];
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([echoTool(received)]),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: audit.sink,
      },
      { sessionId: "sess_t1", model: "mock-1", systemPrompt: "test", now: () => 0 },
    );

    const summary = await loop.run("echo hi and yo");

    expect(summary).toEqual({ sessionId: "sess_t1", turns: 2, toolCalls: 2 });
    expect(sink.events.map((e) => e.type)).toEqual([
      "session_start",
      "user_message",
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
      "assistant_message",
      "session_end",
    ]);
    expect([...received].sort()).toEqual(["hi", "yo"]);
    expect(audit.records.filter((r) => r.decision === "executed")).toHaveLength(2);
    // 组装产物含稳定区 system 消息与工具清单（§5.2）
    expect(llm.requests[0]?.messages[0]?.role).toBe("system");
    expect(llm.requests[0]?.tools?.map((t) => t.name)).toEqual(["echo"]);
  });

  it("onDelta 收到流式文本增量（瞬态，不落 JSONL）", async () => {
    const llm = new ScriptedLLM([{ textParts: ["Hel", "lo"] }]);
    const sink = new MemorySink();
    const deltas: string[] = [];
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([]),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
        onDelta: (d) => {
          deltas.push(d);
        },
      },
      { sessionId: "sess_delta", model: "mock-1", systemPrompt: "test", now: () => 0 },
    );
    await loop.run("hi");
    expect(deltas.join("")).toBe("Hello");
    expect(sink.events.filter((e) => e.type === "assistant_message")).toHaveLength(1);
  });

  it("run 附图进入历史（多模态输入）；updateSystemPrompt 影响下一轮", async () => {
    const llm = new ScriptedLLM([{ text: "ok1" }, { text: "ok2" }]);
    const sink = new MemorySink();
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([]),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
      },
      { sessionId: "sess_img", model: "m", systemPrompt: "base", now: () => 0 },
    );
    await loop.run("看图", { images: ["C:/tmp/a.png"] });
    const firstRequest = llm.requests[0];
    expect((firstRequest?.messages[1] as { images?: string[] } | undefined)?.images).toEqual([
      "C:/tmp/a.png",
    ]);

    loop.updateSystemPrompt("base + 计划模式");
    await loop.run("再问");
    expect(llm.requests[1]?.messages[0]?.content).toContain("计划模式");
  });

  it("技能自动触发：正文注入动态区并落 skill_used 事件（§5.2）", async () => {
    const llm = new ScriptedLLM([{ text: "ok" }]);
    const sink = new MemorySink();
    const skills = {
      meta: () => [{ name: "code-review", description: "审查代码" }],
      body: async () => "审查步骤：1. 读 diff 2. 逐文件给结论",
      match: (input: string) =>
        input.includes("审查")
          ? [{ name: "code-review", description: "审查代码" }]
          : [],
    };
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([]),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
        skills,
      },
      { sessionId: "sess_skill", model: "m", systemPrompt: "t", now: () => 0 },
    );
    await loop.run("帮我审查一下");
    const request = llm.requests[0];
    const messages = request?.messages ?? [];
    expect(messages[1]?.content).toContain("<skill name=\"code-review\">");
    expect(messages[1]?.content).toContain("审查步骤");
    expect(messages[2]?.content).toBe("帮我审查一下");
    expect(
      sink.events.some((e) => e.type === "skill_used" && e.skill === "code-review"),
    ).toBe(true);
  });

  it("权限 deny：工具不执行、留审计、结果标记失败", async () => {
    const llm = new ScriptedLLM([
      { toolCalls: [{ callId: "c1", tool: "echo", args: { msg: "nope" } }] },
      { text: "stopped" },
    ]);
    const sink = new MemorySink();
    const audit = new MemoryAudit();
    const received: string[] = [];
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([echoTool(received)]),
        permissions: denyAll,
        hooks: noHooks,
        sink,
        audit: audit.sink,
      },
      { sessionId: "sess_t2", model: "mock-1", systemPrompt: "test", now: () => 0 },
    );

    await loop.run("try echo");

    expect(received).toEqual([]);
    const resultEvent = sink.events.find(
      (e): e is ToolResultEvent => e.type === "tool_result",
    );
    expect(resultEvent?.ok).toBe(false);
    expect(resultEvent?.error).toContain("permission denied");
    expect(audit.records.some((r) => r.decision === "deny")).toBe(true);
  });
});

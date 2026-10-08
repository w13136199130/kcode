import { describe, expect, it } from "vitest";
import type { Tool } from "@kcode/contracts";
import { AgentLoop } from "../src/core/loop.js";
import {
  InMemoryToolRegistry,
  MemoryAudit,
  MemorySink,
  ScriptedLLM,
  allowAll,
  noHooks,
} from "../src/testing/index.js";

/**
 * steer（N3D-2）：运行中注入在下一模型步边界以 user 消息进入当前请求。
 * 确定性做法：工具 execute 内直接调 loop.steer（同线程，无时序抖动）。
 */

function makeGateTool(onExecute: () => void): Tool {
  return {
    definition: {
      name: "gate",
      description: "测试闸门",
      parameters: { type: "object", properties: {} },
      readOnly: true,
    },
    execute: async () => {
      onExecute();
      return { ok: true, output: "gate-done" };
    },
  };
}

describe("AgentLoop.steer（步边界注入）", () => {
  it("运行中注入：下一模型请求包含注入内容；user_message 事件落盘；Idle 后返回 false", async () => {
    const sink = new MemorySink();
    const llm = new ScriptedLLM([
      { toolCalls: [{ callId: "g1", tool: "gate", args: {} }] },
      { text: "收到注入后的收尾" },
    ]);
    let loopRef!: AgentLoop;
    const gate = makeGateTool(() => {
      // 工具执行期 = 父 run 进行中（phase 非 Idle）——确定性触发 steer
      const steered = loopRef.steer("[SYSTEM MESSAGE - 协调者消息]\n中途补充：只看 src 目录");
      expect(steered).toBe(true);
    });
    loopRef = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([gate]),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
      },
      { sessionId: "steer-1", model: "m", systemPrompt: "t" },
    );
    const summary = await loopRef.run("开始");
    expect(summary.status).toBe("completed");
    // 注入内容以 user 消息进入第二次模型请求
    const secondRequest = llm.requests[1];
    expect(secondRequest).toBeDefined();
    expect(JSON.stringify(secondRequest?.messages)).toContain("中途补充：只看 src 目录");
    // 事件面：注入走既有 user_message（回放/resume 自动一致）
    expect(
      sink.events.some((e) => e.type === "user_message" && e.content.includes("中途补充：只看 src 目录")),
    ).toBe(true);
    // run 结束归位 Idle → steer 拒绝
    expect(loopRef.steer("late")).toBe(false);
  }, 20_000);

  it("Idle 未运行时 steer 恒为 false（两态投递的判据）", () => {
    const loop = new AgentLoop(
      {
        llm: new ScriptedLLM([]),
        tools: new InMemoryToolRegistry([]),
        permissions: allowAll,
        hooks: noHooks,
        sink: new MemorySink(),
        audit: new MemoryAudit().sink,
      },
      { sessionId: "steer-idle", model: "m", systemPrompt: "t" },
    );
    expect(loop.phase).toBe("Idle");
    expect(loop.steer("x")).toBe(false);
  });
});

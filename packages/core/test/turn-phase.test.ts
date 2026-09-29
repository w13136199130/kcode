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
import { TurnPhase } from "../src/core/turn-state.js";

/** N3D-2 前置集成：真实 AgentLoop 全路径只走合法迁移（机器非法即抛，跑通即证明） */

const echoTool: Tool = {
  definition: {
    name: "echo",
    description: "回显",
    parameters: { type: "object", properties: { msg: { type: "string" } } },
    readOnly: true,
  },
  execute: async (input) => ({ ok: true, output: (input as { msg: string }).msg }),
};

function phaseRecorder(): { phases: TurnPhase[]; onPhase: (from: TurnPhase, to: TurnPhase) => void } {
  const phases: TurnPhase[] = [];
  return { phases, onPhase: (_from, to) => phases.push(to) };
}

describe("loop×TurnPhase（迁移序列）", () => {
  it("多轮工具路径：输入→流式→调度→执行→聚合→(回)流式→聚合→完成→归位", async () => {
    const rec = phaseRecorder();
    const loop = new AgentLoop(
      {
        llm: new ScriptedLLM([
          { toolCalls: [{ callId: "c1", tool: "echo", args: { msg: "hi" } }] },
          { text: "done" },
        ]),
        tools: new InMemoryToolRegistry([echoTool]),
        permissions: allowAll,
        hooks: noHooks,
        sink: new MemorySink(),
        audit: new MemoryAudit().sink,
        onPhase: rec.onPhase,
      },
      { sessionId: "phase-multi", model: "m", systemPrompt: "t" },
    );
    const summary = await loop.run("go");
    expect(summary.status).toBe("completed");
    expect(rec.phases).toEqual([
      TurnPhase.ProcessingInput,
      TurnPhase.Streaming,
      TurnPhase.SchedulingTools,
      TurnPhase.ExecutingTools,
      TurnPhase.AggregatingResults,
      TurnPhase.Streaming,
      TurnPhase.AggregatingResults,
      TurnPhase.Completing,
      TurnPhase.Idle,
    ]);
  }, 20_000);

  it("纯文本一轮：输入→流式→聚合→完成→归位", async () => {
    const rec = phaseRecorder();
    const loop = new AgentLoop(
      {
        llm: new ScriptedLLM([{ text: "ok" }]),
        tools: new InMemoryToolRegistry([]),
        permissions: allowAll,
        hooks: noHooks,
        sink: new MemorySink(),
        audit: new MemoryAudit().sink,
        onPhase: rec.onPhase,
      },
      { sessionId: "phase-text", model: "m", systemPrompt: "t" },
    );
    await loop.run("go");
    expect(rec.phases).toEqual([
      TurnPhase.ProcessingInput,
      TurnPhase.Streaming,
      TurnPhase.AggregatingResults,
      TurnPhase.Completing,
      TurnPhase.Idle,
    ]);
  });

  it("流式错误走 Error 归位；连续两次 run 均从 Idle 干净起步", async () => {
    const rec = phaseRecorder();
    const loop = new AgentLoop(
      {
        llm: new ScriptedLLM([{ text: "x", error: "端点 401" }]),
        tools: new InMemoryToolRegistry([]),
        permissions: allowAll,
        hooks: noHooks,
        sink: new MemorySink(),
        audit: new MemoryAudit().sink,
        onPhase: rec.onPhase,
      },
      { sessionId: "phase-err", model: "m", systemPrompt: "t" },
    );
    const failed = await loop.run("go");
    expect(failed.status).toBe("failed");
    expect(rec.phases).toEqual([
      TurnPhase.ProcessingInput,
      TurnPhase.Streaming,
      TurnPhase.Error,
      TurnPhase.Idle,
    ]);
    // 同一 loop 实例第二轮（脚本续跑）：仍从 ProcessingInput 干净起步
    rec.phases.length = 0;
    const again = await loop.run("again");
    expect(again.status).toBe("completed");
    expect(rec.phases[0]).toBe(TurnPhase.ProcessingInput);
    expect(rec.phases.at(-1)).toBe(TurnPhase.Idle);
  }, 20_000);
});

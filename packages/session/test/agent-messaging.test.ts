import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLLM, type ScriptedTurn } from "@kcode/core";
import type { SessionEvent } from "@kcode/contracts";
import { AgentLoop, InMemoryToolRegistry, MemoryAudit, MemorySink, allowAll, noHooks } from "@kcode/core";
import { composeSession } from "../src/composition.js";
import { SubagentRegistry, buildSendMessageTool, buildRespondToCoordinatorTool, STEER_HEADER } from "../src/index.js";

/**
 * N3D-2 主体：两态投递（steered/resumed）+ respond_to_coordinator 通知链 + 句柄 LRU。
 */

let home: string;
let workspace: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-msg-home-"));
  workspace = await mkdtemp(join(tmpdir(), "kcode-msg-ws-"));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 造一个真实 AgentLoop + 持有其 ScriptedLLM（requests 供断言） */
function makeLoop(script: ScriptedTurn[]): { loop: AgentLoop; llm: ScriptedLLM } {
  const llm = new ScriptedLLM(script);
  const loop = new AgentLoop(
    {
      llm,
      tools: new InMemoryToolRegistry([]),
      permissions: allowAll,
      hooks: noHooks,
      sink: new MemorySink(),
      audit: new MemoryAudit().sink,
    },
    { sessionId: `sess_msg_${Math.random().toString(36).slice(2, 8)}`, model: "scripted/simple", systemPrompt: "t" },
  );
  return { loop, llm };
}

describe("SendMessage 两态投递", () => {
  it("未知 id 报错并列出可寻址清单", async () => {
    const registry = new SubagentRegistry();
    const tool = buildSendMessageTool({ registry });
    const r = await tool.execute({ agentId: "sub_none", message: "hi" }, { sessionId: "s", cwd: "." });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("未知子代理");
  });

  it("终态句柄 → resumed：同 loop 开新 run，注入内容（含防伪头）进入模型请求；状态翻转正确", async () => {
    const registry = new SubagentRegistry();
    const { loop, llm } = makeLoop([{ text: "第一轮完成" }, { text: "续跑回答" }]);
    await loop.run("初始任务"); // 完成 → Idle
    registry.register({ id: "sub_r1", agentType: "explore", description: "调研", loop, status: "finished" });

    const tool = buildSendMessageTool({ registry });
    const r = await tool.execute({ agentId: "sub_r1", message: "补充：只要测试文件" }, { sessionId: "s", cwd: "." });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("resumed");
    expect(registry.get("sub_r1")?.status).toBe("running"); // 立即翻转
    await waitFor(() => registry.get("sub_r1")?.status === "finished");
    expect(llm.requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(llm.requests.at(-1)?.messages)).toContain("只要测试文件");
    expect(JSON.stringify(llm.requests.at(-1)?.messages)).toContain(STEER_HEADER);
  }, 20_000);

  it("句柄 LRU：终态句柄超 8 个逐出最旧（不可再寻址）", () => {
    const registry = new SubagentRegistry();
    for (let i = 0; i < 10; i++) {
      const { loop } = makeLoop([]);
      registry.register({ id: `sub_l${i}`, agentType: "explore", description: `d${i}`, loop, status: "finished" });
    }
    registry.markTerminal("sub_l9"); // 触发逐出：10 个终态 → 逐出最旧 2 个
    expect(registry.get("sub_l0")).toBeUndefined();
    expect(registry.get("sub_l1")).toBeUndefined();
    expect(registry.get("sub_l2")).toBeDefined();
    expect(registry.list()).toHaveLength(8);
  });
});

describe("RespondToCoordinator（通知链）", () => {
  it("载荷经 notify 送达：subagent-message XML 包裹；工具回执非阻塞", async () => {
    const delivered: string[] = [];
    const tool = buildRespondToCoordinatorTool({
      childId: "sub_c1",
      childType: "general-purpose",
      notify: (text) => delivered.push(text),
    });
    const r = await tool.execute({ message: "中间发现：入口在 main.ts" }, { sessionId: "s", cwd: "." });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("已送达");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("<subagent-message>");
    expect(delivered[0]).toContain("<agent-id>sub_c1</agent-id>");
    expect(delivered[0]).toContain("中间发现：入口在 main.ts");
  });

  it("组合级全链路：后台子代理 respond → 父收到通知并开新 turn 应答", async () => {
    const events: SessionEvent[] = [];
    let created = 0;
    const session = await composeSession({
      llmFactory: async () => {
        created += 1;
        if (created === 1) {
          // 父：派后台子代理 → 收尾本轮 →（通知到达后）第三轮应答
          return new ScriptedLLM([
            {
              toolCalls: [
                {
                  callId: "t1",
                  tool: "task",
                  args: { subagent_type: "explore", description: "后台调研", prompt: "找入口", wait: "background" },
                },
              ],
            },
            { text: "已派出" },
            { text: "收到子代理的中间发现" },
          ]);
        }
        // 子代理：先 respond 中间发现，再出结论
        return new ScriptedLLM([
          { toolCalls: [{ callId: "r1", tool: "respond_to_coordinator", args: { message: "中间发现：入口在 main.ts" } }] },
          { text: "结论：入口 main.ts" },
        ]);
      },
      model: "scripted/simple",
      cwd: workspace,
      kcodeHomeDir: home,
      onEvent: (e) => events.push(e),
    });
    await session.loop.run("帮我调研入口");
    await waitFor(() =>
      events.some((e) => e.type === "user_message" && e.content.includes("<subagent-message>") && e.content.includes("入口在 main.ts")),
    );
    await waitFor(() => events.some((e) => e.type === "assistant_message" && e.content.includes("收到子代理的中间发现")));
    await session.close();
  }, 30_000);
});

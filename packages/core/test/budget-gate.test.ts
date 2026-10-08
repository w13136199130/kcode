import { describe, expect, it } from "vitest";
import { AgentLoop } from "../src/core/loop.js";
import { InMemoryToolRegistry, MemoryAudit, MemorySink, ScriptedLLM, allowAll, noHooks } from "../src/testing/index.js";

/** N3I-8 会话 token 预算护栏：轮间门——到顶问询一次，停止拒本轮不发请求，继续不再问 */

function makeLoop(
  budget: number,
  onBudgetLimit?: (used: { inputTokens: number; outputTokens: number; calls: number }, max: number) => Promise<boolean>,
  turns: Array<{ text: string; usage?: { inputTokens: number; outputTokens: number } }> = [
    { text: "ok", usage: { inputTokens: 80_000, outputTokens: 5_000 } },
    { text: "ok2" },
  ],
) {
  const sink = new MemorySink();
  const loop = new AgentLoop(
    {
      llm: new ScriptedLLM(turns),
      tools: new InMemoryToolRegistry([]),
      permissions: allowAll,
      hooks: noHooks,
      sink,
      audit: new MemoryAudit().sink,
    },
    { sessionId: "budget-test", model: "m", systemPrompt: "t", sessionBudgetTokens: budget, onBudgetLimit },
  );
  return { sink, loop, llmCalls: turns };
}

describe("会话 token 预算护栏（N3I-8）", () => {
  it("未到预算不问询；单轮用量累计入 sessionUsage/contextStats", async () => {
    const { sink, loop } = makeLoop(1_000_000); // 预算远大于用量
    const r = await loop.run("go");
    expect(r.status).toBe("completed");
    expect(sink.events.filter((e) => e.type === "session_end")).toHaveLength(1);
    const stats = loop.contextStats();
    expect(stats.sessionUsage.inputTokens).toBe(80_000);
    expect(stats.sessionBudgetTokens).toBe(1_000_000);
  });

  it("到顶问询选停止：本轮拒发（turns 0、不再调 LLM），session_end 带预算说明", async () => {
    let asked = 0;
    const { sink, loop } = makeLoop(50_000, async () => {
      asked += 1;
      return false;
    });
    await loop.run("go"); // 用掉 85k（超 50k 预算）
    const r2 = await loop.run("again");
    expect(r2).toMatchObject({ status: "rejected", turns: 0, toolCalls: 0 });
    expect(asked).toBe(1);
    const end = sink.events.filter((e) => e.type === "session_end").at(-1);
    expect(end).toMatchObject({ reason: "rejected" });
    expect((end as { detail?: string }).detail).toContain("预算已用尽");
    // 拒绝轮没有产生 user_message（不发请求、不进历史）
    const userMsgs = sink.events.filter((e) => e.type === "user_message");
    expect(userMsgs).toHaveLength(1);
  });

  it("到顶问询选继续：本轮照常执行，且本会话不再问（第二次到顶直接放行）", async () => {
    let asked = 0;
    const { loop } = makeLoop(50_000, async () => {
      asked += 1;
      return true;
    });
    await loop.run("go"); // 85k > 50k——首轮结束累计后，下一轮才触发
    const r2 = await loop.run("again");
    expect(asked).toBe(1);
    expect(r2.status).toBe("completed");
    const r3 = await loop.run("third");
    expect(asked).toBe(1); // 已确认继续：不再问
    expect(r3.status).toBe("completed");
  });

  it("不可交互（无 onBudgetLimit，headless 同款）按停止 fail-closed", async () => {
    const { loop } = makeLoop(50_000); // 无回调
    await loop.run("go");
    const r2 = await loop.run("again");
    expect(r2).toMatchObject({ status: "rejected", turns: 0 });
  });
});

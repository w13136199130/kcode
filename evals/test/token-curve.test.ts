import { describe, expect, it } from "vitest";
import type { Tool } from "@kcode/contracts";
import {
  AgentLoop,
  InMemoryToolRegistry,
  MemoryAudit,
  MemorySink,
  ScriptedLLM,
  allowAll,
  noHooks,
  type ScriptedTurn,
} from "@kcode/core";
import { estimateTokens } from "@kcode/shared";

/** 每轮注入的大工具结果：约 1333 token，用于快速推高历史体积 */
const BIG_OUTPUT = "x".repeat(4000);
/** 历史预算：远小于会累积的体积，保证压缩在会话中途多次触发 */
const HISTORY_BUDGET = 5000;
const TURNS = 14;

/**
 * 长会话 token 曲线验收：
 * 持续注入大体积工具结果时，压缩应把每轮输入的 token 数压回预算附近（曲线走平），
 * 且任务锚点与摘要始终保留在上下文中。
 */
describe("长会话 token 曲线（上下文工程验收）", () => {
  it("压缩触发后曲线走平，任务锚点与摘要保留", async () => {
    const dump: Tool = {
      definition: {
        name: "dump",
        description: "输出大段内容",
        parameters: { type: "object" },
        readOnly: false,
      },
      execute: async () => ({ ok: true, output: BIG_OUTPUT }),
    };

    const script: ScriptedTurn[] = [];
    for (let i = 0; i < TURNS; i++) {
      // 文本与工具调用放在同一轮：只有不含工具调用的轮次才会结束会话
      script.push({
        text: `第 ${i + 1} 轮完成，继续。`,
        toolCalls: [{ callId: `c${i}`, tool: "dump", args: { i } }],
      });
    }
    const llm = new ScriptedLLM(script);

    const sink = new MemorySink();
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([dump]),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
        summarizer: {
          summarize: async (input) =>
            `【摘要】已压缩 ${input.messages.length} 条消息；任务为长会话曲线测试；结论：内容无异常。`,
        },
      },
      {
        sessionId: "sess_curve",
        model: "m",
        systemPrompt: "t",
        now: () => 0,
        maxTurns: 60,
        budget: { system: 4096, history: HISTORY_BUDGET, toolResult: 8192 },
      },
    );

    await loop.run("开始长会话曲线测试：逐轮读取大文件并汇报");

    // 每轮请求的输入 token 数（含稳定区/摘要/近期历史）；
    // 末尾多出的一次请求是脚本耗尽后的收尾轮（无工具调用即结束）
    const curve = llm.requests.map((r) => estimateTokens(JSON.stringify(r.messages)));
    expect(curve).toHaveLength(TURNS + 1);

    const peak = Math.max(...curve);
    const tail = curve.slice(-6);
    const tailSpread = Math.max(...tail) - Math.min(...tail);

    // 初期确实在增长（历史不断累积）
    expect(curve[2] ?? 0).toBeGreaterThan(curve[0] ?? 0);
    // 全程有界：注入了约 5 倍预算的文本量，峰值仍被压在预算附近
    expect(peak).toBeLessThan(HISTORY_BUDGET + 2000);
    // 曲线走平：终点回到预算内，且后半程在窄幅区间震荡（不再持续爬升）
    expect(curve[curve.length - 1] ?? 0).toBeLessThan(HISTORY_BUDGET);
    expect(tailSpread).toBeLessThan(3500);

    // 压缩确实发生过，且锚点与摘要保留在最后一轮请求中
    expect(sink.events.filter((e) => e.type === "compaction_summary").length).toBeGreaterThanOrEqual(1);
    const lastMessages = llm.requests[llm.requests.length - 1]?.messages ?? [];
    expect(lastMessages.some((m) => m.content.includes("开始长会话曲线测试"))).toBe(true);
    expect(lastMessages.some((m) => m.content.includes("【摘要】"))).toBe(true);
  });
}, 120_000);

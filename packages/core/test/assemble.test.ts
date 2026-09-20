import { describe, expect, it } from "vitest";
import type { ChatMessage, SkillMeta, ToolDefinition } from "@kcode/contracts";
import { assembleMessages } from "../src/context/assemble.js";
import { DEFAULT_BUDGET } from "../src/context/budget.js";
import {
  COMPACTION_KEEP_TAIL,
  COMPACTION_MIN_MESSAGES,
  applyCompaction,
  planCompaction,
} from "../src/context/compact.js";

const tool = (name: string): ToolDefinition => ({
  name,
  description: `tool ${name}`,
  parameters: { type: "object" },
  readOnly: true,
});

const skill = (name: string): SkillMeta => ({ name, description: `skill ${name}` });

describe("cache 友好组装（§5.2）", () => {
  it("工具顺序不影响稳定区字节（前缀逐字节稳定）", () => {
    const history: ChatMessage[] = [{ role: "user", content: "hi" }];
    const a = assembleMessages({ systemPrompt: "sys", tools: [tool("b"), tool("a")], history });
    const b = assembleMessages({ systemPrompt: "sys", tools: [tool("a"), tool("b")], history });
    expect(a[0]).toEqual(b[0]);
    expect(a[0]?.content).toContain("Tools:\n- a: tool a\n- b: tool b");
  });

  it("历史原样保留在动态位", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "q" },
      { role: "tool", content: "r", toolCallId: "c1", name: "echo" },
    ];
    const out = assembleMessages({ systemPrompt: "sys", tools: [], history });
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual(history[0]);
  });

  it("AGENTS.md 与技能元数据进稳定区，顺序与排序确定（§5.2/§5.3）", () => {
    const history: ChatMessage[] = [{ role: "user", content: "q" }];
    const a = assembleMessages({
      systemPrompt: "sys",
      agentsMd: "团队约定：测试放 test/ 目录",
      tools: [tool("b"), tool("a")],
      skills: [skill("z-skill"), skill("a-skill")],
      history,
    });
    const system = a[0]?.content ?? "";
    const iSys = system.indexOf("sys");
    const iAgents = system.indexOf("AGENTS.md");
    const iTools = system.indexOf("Tools:");
    const iSkills = system.indexOf("Skills");
    expect([iSys, iAgents, iTools, iSkills].every((i) => i >= 0)).toBe(true);
    expect(iSys).toBeLessThan(iAgents);
    expect(iAgents).toBeLessThan(iTools);
    expect(iTools).toBeLessThan(iSkills);
    expect(system).toContain("- a-skill: skill a-skill");
    expect(system).toContain("团队约定");
  });
});

describe("上下文压缩方案", () => {
  const tiny = { ...DEFAULT_BUDGET, history: 10 };

  it("未超预算或历史过短不触发压缩", () => {
    expect(planCompaction([{ role: "user", content: "small" }], DEFAULT_BUDGET)).toBeNull();
    const tooShort = Array.from({ length: COMPACTION_MIN_MESSAGES - 1 }, (_, i) => ({
      role: "user" as const,
      content: `${i}`,
    }));
    expect(planCompaction(tooShort, tiny)).toBeNull();
  });

  it("超预算时切分：近期保留、较早进摘要区、首条用户消息为任务锚点", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "任务目标" },
      ...Array.from({ length: 12 }, (_, i) => ({
        role: (i % 2 === 0 ? "assistant" : "user") as "assistant" | "user",
        content: "x".repeat(60),
      })),
    ];
    const plan = planCompaction(history, tiny);
    expect(plan).not.toBeNull();
    expect(plan?.keepTail).toHaveLength(COMPACTION_KEEP_TAIL);
    expect(plan?.toSummarize).toHaveLength(history.length - COMPACTION_KEEP_TAIL);
    expect(plan?.taskAnchor?.content).toBe("任务目标");

    const applied = applyCompaction(plan!, "【摘要】ok");
    expect(applied.dropped).toBe(history.length - COMPACTION_KEEP_TAIL);
    expect(applied.history[0]?.content).toBe("任务目标");
    expect(applied.history[1]).toMatchObject({ role: "assistant", content: "【摘要】ok" });
    expect(applied.history.at(-1)).toBe(history.at(-1));
  });
});

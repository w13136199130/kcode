import { describe, expect, it } from "vitest";
import type { ChatMessage, SkillMeta, ToolDefinition } from "@kcode/contracts";
import { assembleMessages } from "../src/context/assemble.js";
import { DEFAULT_BUDGET } from "../src/context/budget.js";
import { compactHistory } from "../src/context/compact.js";

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

describe("压缩（§5.2）", () => {
  it("超预算触发压缩：丢中段 tool 消息并产出摘要", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: "ok" },
      { role: "tool", content: "x".repeat(400), toolCallId: "c1", name: "echo" },
      { role: "tool", content: "y".repeat(400), toolCallId: "c2", name: "echo" },
      { role: "assistant", content: "end" },
      { role: "user", content: "next" },
    ];
    const tiny = { ...DEFAULT_BUDGET, history: 100 };
    const outcome = compactHistory(history, tiny);
    expect(outcome).not.toBeNull();
    expect(outcome?.dropped).toBe(2);
    expect(outcome?.summary).toContain("compacted");
  });

  it("未超预算不压缩", () => {
    const history: ChatMessage[] = [{ role: "user", content: "small" }];
    expect(compactHistory(history, DEFAULT_BUDGET)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { SessionSink, SessionEvent } from "@kcode/contracts";
import { buildSkillTool, formatSkillCatalog } from "../src/skill-tool.js";

/**
 * Skill 显式工具（工具面补全）：模型按名读取技能正文。
 * 验证正文返回、skill_used 事件（trigger=tool）落盘、未知技能报错列出可用清单。
 */

function makeSkills(catalog: Record<string, string>) {
  return {
    meta: () => Object.entries(catalog).map(([name, description]) => ({ name, description })),
    body: async (name: string) => catalog[name] ?? null,
  };
}

function capturingSink(): { sink: SessionSink; events: SessionEvent[] } {
  const events: SessionEvent[] = [];
  return { events, sink: { append: async (e) => { events.push(e); } } };
}

describe("skill 工具（显式加载）", () => {
  it("按名返回正文，并经 sink 落 skill_used（trigger=tool）事件", async () => {
    const { sink, events } = capturingSink();
    const tool = buildSkillTool({
      skills: makeSkills({ deploy: "部署流程", review: "代码审查" }),
      sink,
      sessionId: "s1",
    });
    // 描述内联可用技能名+用途（N3I-2：模型按意图匹配，不再只按名字猜）
    expect(tool.definition.description).toContain("deploy");
    expect(tool.definition.description).toContain("review");
    expect(tool.definition.description).toContain("部署流程");

    const r = await tool.execute({ name: "deploy" }, { sessionId: "s1", cwd: "." });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("部署流程");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "skill_used", skill: "deploy", trigger: "tool" });
  });

  it("未知技能报错并列出可用清单；只读放行（plan 档也可用）", async () => {
    const { sink, events } = capturingSink();
    const tool = buildSkillTool({ skills: makeSkills({ deploy: "部署" }), sink, sessionId: "s1" });
    const r = await tool.execute({ name: "nope" }, { sessionId: "s1", cwd: "." });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("未知技能");
    expect(r.error).toContain("deploy");
    expect(events).toHaveLength(0); // 失败路径不落事件
    expect(tool.definition.readOnly).toBe(true);
    expect(tool.definition.permission).toEqual({ default: "allow" });
  });
});

describe("formatSkillCatalog（N3I-2 技能描述可见性）", () => {
  it("逐行 name（description）；超 80 字符截断加省略号", () => {
    const out = formatSkillCatalog([
      { name: "deploy", description: "部署流程".repeat(30) }, // 120 字符 > 80
      { name: "review", description: "代码审查" },
    ]);
    expect(out).toContain("- deploy（");
    expect(out).toContain("- review（代码审查）");
    const deployLine = out.split("\n").find((l) => l.includes("deploy")) ?? "";
    expect(deployLine.length).toBeLessThanOrEqual("- deploy（".length + 80 + "…）".length);
    expect(deployLine.endsWith("…）")).toBe(true);
  });

  it("总预算超限降级仅名字（2K 字符）", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `skill-${i}`,
      description: "用途".repeat(40), // 每条 ~80 字符 → 40 条远超 2K
    }));
    const out = formatSkillCatalog(many);
    expect(out).toContain("skill-0");
    expect(out).toContain("skill-39");
    expect(out).not.toContain("（用途"); // 已降级：不再带描述
    expect(out.length).toBeLessThanOrEqual(2_000 + 10);
  });

  it("空清单返回（无）", () => {
    expect(formatSkillCatalog([])).toBe("（无）");
  });
});

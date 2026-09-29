import { describe, expect, it } from "vitest";
import type { SessionSink, SessionEvent } from "@kcode/contracts";
import { buildSkillTool } from "../src/skill-tool.js";

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
    // 描述内联可用技能名（模型无需先查清单）
    expect(tool.definition.description).toContain("deploy");
    expect(tool.definition.description).toContain("review");

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

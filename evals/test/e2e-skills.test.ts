import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionEvent } from "@kcode/contracts";
import {
  AgentLoop,
  InMemoryToolRegistry,
  MemoryAudit,
  MemorySink,
  ScriptedLLM,
  allowAll,
  noHooks,
} from "@kcode/core";
import { FsSkillLibrary } from "@kcode/extensions";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-e2esk-"));
  await mkdir(join(root, ".kcode", "skills", "code-review"), { recursive: true });
  await writeFile(
    join(root, ".kcode", "skills", "code-review", "SKILL.md"),
    "---\nname: code-review\ndescription: 审查代码质量\ntriggers:\n  - 审查\n---\n审查步骤：读 diff，逐文件给结论。",
    "utf8",
  );
  await writeFile(join(root, "AGENTS.md"), "# 项目约定\n- 测试文件放 test/ 目录", "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("P2-1/2-2 E2E：AGENTS.md 记忆 + SKILL.md 渐进加载/自动触发（真实文件系统）", () => {
  it("AGENTS.md 进稳定区；触发词命中后技能正文注入动态区并落事件", async () => {
    const llm = new ScriptedLLM([{ text: "收到，按技能流程审查。" }]);
    const sink = new MemorySink();
    const skills = await FsSkillLibrary.open([
      { dir: join(root, ".kcode", "skills"), source: "project" },
    ]);
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
      { sessionId: "sess_p2", model: "m", systemPrompt: "t", cwd: root, now: () => 0 },
    );
    // agentsMd 由组合层读取注入（CLI session 同款职责，此处直读模拟）
    const { readFile } = await import("node:fs/promises");
    const agentsMd = await readFile(join(root, "AGENTS.md"), "utf8");
    (loop as unknown as { opts: { agentsMd?: string } }).opts.agentsMd = agentsMd;

    await loop.run("帮我审查一下变更");

    const system = llm.requests[0]?.messages[0]?.content ?? "";
    expect(system).toContain("AGENTS.md");
    expect(system).toContain("测试文件放 test/");
    expect(system).toContain("- code-review: 审查代码质量");
    expect(llm.requests[0]?.messages[1]?.content).toContain("审查步骤");
    expect(
      sink.events.some((e): e is Extract<SessionEvent, { type: "skill_used" }> => e.type === "skill_used"),
    ).toBe(true);
  });
});

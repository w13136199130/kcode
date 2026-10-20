import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLLM } from "@kcode/core";
import { composeSession } from "../src/index.js";
import { openFileAuditSink } from "../src/audit.js";

/** 3-29：审计落盘——工具/裁决/scope/耗时/cwd/模式，子代理记录带父会话 */
let home: string;
let workspace: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-audit-"));
  workspace = await mkdtemp(join(tmpdir(), "kcode-audit-ws-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

describe("FileAuditSink", () => {
  it("按序追加 JSONL，close 排空", async () => {
    const path = join(home, "audit-unit", "a.jsonl");
    const file = await openFileAuditSink(path);
    file.sink({ ts: 1, sessionId: "s", callId: "c1", tool: "read", decision: "executed", durationMs: 3 });
    file.sink({ ts: 2, sessionId: "s", callId: "c2", tool: "bash", decision: "deny", scope: "once" });
    await file.close();
    const lines = (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { tool: string });
    expect(lines.map((l) => l.tool)).toEqual(["read", "bash"]);
  });
});

describe("会话审计", () => {
  it("主会话工具执行落盘：decision/duration/cwd/mode", async () => {
    const llm = new ScriptedLLM([
      { toolCalls: [{ callId: "todo1", tool: "todo", args: { todos: [{ content: "a", status: "in_progress" }] } }] },
      { text: "done" },
    ]);
    const session = await composeSession({
      llmFactory: async () => llm,
      model: "m",
      cwd: workspace,
      kcodeHomeDir: home,
      sessionId: "audit_sess",
      onEvent: () => {},
    });
    await session.loop.run("跑");
    await session.close();
    const path = join(home, "cli", "audit", "audit_sess.jsonl");
    const records = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { tool: string; decision: string; durationMs?: number; cwd?: string; mode?: string });
    const executed = records.find((r) => r.tool === "todo" && r.decision === "executed");
    expect(executed).toBeDefined();
    expect(executed?.cwd).toBe(workspace);
    expect(executed?.mode).toBe("default");
    expect(executed?.durationMs).toBeGreaterThanOrEqual(0);
  }, 20_000);

  it("子代理工具记录带 parentSessionId", async () => {
    const llms: ScriptedLLM[] = [];
    const session = await composeSession({
      llmFactory: async () => {
        const llm = new ScriptedLLM(
          llms.length === 0
            ? [
                {
                  toolCalls: [
                    {
                      callId: "t1",
                      tool: "task",
                      args: { subagent_type: "explore", description: "审计子代理", prompt: "跑个 glob" },
                    },
                  ],
                },
                { text: "done" },
              ]
            : [
                { toolCalls: [{ callId: "g1", tool: "glob", args: { pattern: "*.md" } }] },
                { text: "子代理结论" },
              ],
        );
        llms.push(llm);
        return llm;
      },
      model: "m",
      cwd: workspace,
      kcodeHomeDir: home,
      sessionId: "audit_parent",
      onEvent: () => {},
    });
    await session.loop.run("派子代理");
    await session.close();
    const records = (await readFile(join(home, "cli", "audit", "audit_parent.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { tool: string; sessionId: string; parentSessionId?: string });
    const childGlob = records.find((r) => r.tool === "glob");
    expect(childGlob).toBeDefined();
    expect(childGlob?.sessionId).toMatch(/^sub_/);
    expect(childGlob?.parentSessionId).toBe("audit_parent");
  }, 30_000);
});

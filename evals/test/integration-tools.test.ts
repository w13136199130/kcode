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
import { readOnlyTools } from "@kcode/tools";

type ToolResultEvent = Extract<SessionEvent, { type: "tool_result" }>;

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-e2e-"));
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "a.txt"), "alpha\nbeta\n", "utf8");
  await writeFile(join(root, "sub", "b.ts"), "const x = 1;\n// TODO: fix me\n", "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("集成：只读三件套接入 core loop（P1-1 验收前置）", () => {
  it("一轮内 read+grep 并发执行，结果按调用序回填", async () => {
    const sink = new MemorySink();
    const loop = new AgentLoop(
      {
        llm: new ScriptedLLM([
          {
            toolCalls: [
              { callId: "r1", tool: "read", args: { path: "a.txt" } },
              { callId: "g1", tool: "grep", args: { pattern: "TODO" } },
            ],
          },
          { text: "done" },
        ]),
        tools: new InMemoryToolRegistry(readOnlyTools),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
      },
      { sessionId: "sess_e2e", model: "mock-1", systemPrompt: "integration", cwd: root, now: () => 0 },
    );

    const summary = await loop.run("看下 a.txt 并找 TODO");

    expect(summary.toolCalls).toBe(2);
    const results = sink.events.filter(
      (e): e is ToolResultEvent => e.type === "tool_result",
    );
    expect(results.map((r) => r.callId)).toEqual(["r1", "g1"]);
    expect(results[0]?.output).toContain("1→alpha");
    expect(results[1]?.output).toContain("TODO: fix me");
    // 全部只读 → 两工具并发（§5.1），审计均 executed
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

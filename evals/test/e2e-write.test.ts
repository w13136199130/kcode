import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { DEFAULT_RULES, RuleBasedPermissionEngine } from "@kcode/extensions";
import { builtinTools } from "@kcode/tools";

type ToolResultEvent = Extract<SessionEvent, { type: "tool_result" }>;

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-e2ew-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function writeScript(): InstanceType<typeof ScriptedLLM> {
  return new ScriptedLLM([
    { toolCalls: [{ callId: "w1", tool: "write", args: { path: "out.txt", content: "hello kcode" } }] },
    { text: "已写入 out.txt。" },
  ]);
}

describe("P1-4 E2E：写入工具 × 权限引擎", () => {
  it("yolo（allow）→ 文件真实写入磁盘", async () => {
    const sink = new MemorySink();
    const loop = new AgentLoop(
      {
        llm: writeScript(),
        tools: new InMemoryToolRegistry(builtinTools),
        permissions: allowAll,
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
      },
      { sessionId: "sess_w1", model: "m", systemPrompt: "t", cwd: join(root, "allow"), now: () => 0 },
    );
    await loop.run("写文件");
    expect(await readFile(join(root, "allow", "out.txt"), "utf8")).toBe("hello kcode");
    const result = sink.events.find((e): e is ToolResultEvent => e.type === "tool_result");
    expect(result?.ok).toBe(true);
  });

  it("default 预设 + 用户拒绝 ask → 文件不写入、结果失败、留审计", async () => {
    const sink = new MemorySink();
    const audit = new MemoryAudit();
    const loop = new AgentLoop(
      {
        llm: writeScript(),
        tools: new InMemoryToolRegistry(builtinTools),
        permissions: new RuleBasedPermissionEngine({ rules: DEFAULT_RULES, fallback: "deny" }),
        hooks: noHooks,
        sink,
        audit: audit.sink,
        asker: { confirm: async () => false },
      },
      { sessionId: "sess_w2", model: "m", systemPrompt: "t", cwd: join(root, "deny"), now: () => 0 },
    );
    await loop.run("写文件");
    expect(existsSync(join(root, "deny", "out.txt"))).toBe(false);
    const result = sink.events.find((e): e is ToolResultEvent => e.type === "tool_result");
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("permission denied");
    expect(audit.records.some((r) => r.decision === "ask-denied" && r.detail === "user denied")).toBe(true);
  });

  it("default 预设 + 用户放行 ask → 写入成功", async () => {
    const sink = new MemorySink();
    const loop = new AgentLoop(
      {
        llm: writeScript(),
        tools: new InMemoryToolRegistry(builtinTools),
        permissions: new RuleBasedPermissionEngine({ rules: DEFAULT_RULES, fallback: "deny" }),
        hooks: noHooks,
        sink,
        audit: new MemoryAudit().sink,
        asker: { confirm: async () => true },
      },
      { sessionId: "sess_w3", model: "m", systemPrompt: "t", cwd: join(root, "askok"), now: () => 0 },
    );
    await loop.run("写文件");
    expect(await readFile(join(root, "askok", "out.txt"), "utf8")).toBe("hello kcode");
  });
});

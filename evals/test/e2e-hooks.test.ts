import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
} from "@kcode/core";
import { ProcessHookRunner } from "@kcode/extensions";
import { simpleEchoTool } from "./helpers.js";

type ToolResultEvent = Extract<SessionEvent, { type: "tool_result" }>;

let root: string;
let blockScript: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-e2ehook-"));
  blockScript = join(root, "block.mjs");
  await writeFile(
    blockScript,
    'import { readFileSync } from "node:fs";\n' +
      'const input = JSON.parse(readFileSync(0, "utf8"));\n' +
      'console.log(`策略禁止执行 ${input.tool}（载荷 ${input.callId} 已记录）`);\n' +
      "process.exit(2);\n",
    "utf8",
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("钩子与循环集成：拦截真实工具调用", () => {
  it("pre_tool_use 钩子退出码 2 → 工具不执行、结果带拦截原因", async () => {
    const sink = new MemorySink();
    const hooks = new ProcessHookRunner(
      [{ event: "pre_tool_use", command: `node "${blockScript}"` }],
      { sessionId: "sess_hook", onWarn: () => {} },
    );
    const loop = new AgentLoop(
      {
        llm: new ScriptedLLM([
          { toolCalls: [{ callId: "c1", tool: "echo", args: { msg: "敏感内容" } }] },
          { text: "写入被策略拦截。" },
        ]),
        tools: new InMemoryToolRegistry([simpleEchoTool()]),
        permissions: allowAll,
        hooks,
        sink,
        audit: new MemoryAudit().sink,
      },
      { sessionId: "sess_hook", model: "m", systemPrompt: "t", now: () => 0 },
    );

    await loop.run("尝试回显");

    // 钩子在权限放行之后执行：权限引擎放行，钩子拦截，工具体未运行
    const result = sink.events.find((e): e is ToolResultEvent => e.type === "tool_result");
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("策略禁止执行 echo");
    // 会话生命周期钩子（session_start/stop）在无匹配配置时静默通过
    expect(sink.events.at(-1)?.type).toBe("session_end");
  });
});

import type { SessionEvent, Tool } from "@kcode/contracts";
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

export interface ReplayHarnessOptions {
  sessionId: string;
  userInput: string;
  script: ScriptedTurn[];
  tools: Tool[];
}

/**
 * 回放 harness（§8.2 replay 安全：mock LLM + 内存 sink，hooks no-op——真实命令/hooks 永不执行）。
 * 夹具（JSONL）与产出的对比见 runtime.compareIgnoringTs。
 */
export async function runScriptedSession(opts: ReplayHarnessOptions): Promise<SessionEvent[]> {
  const sink = new MemorySink();
  const loop = new AgentLoop(
    {
      llm: new ScriptedLLM(opts.script),
      tools: new InMemoryToolRegistry(opts.tools),
      permissions: allowAll,
      hooks: noHooks,
      sink,
      audit: new MemoryAudit().sink,
    },
    {
      sessionId: opts.sessionId,
      model: "mock-1",
      systemPrompt: "replay",
      now: () => 0,
    },
  );
  await loop.run(opts.userInput);
  return sink.events;
}

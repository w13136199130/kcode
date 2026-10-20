import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLLM } from "@kcode/core";
import { composeSession, resolveResumeHistory } from "../src/index.js";

/**
 * 3-13：todo 回注与续接恢复。
 * 工具更新清单后下一轮模型可见；续接旧会话时从 JSONL 最后一个 todo_update 恢复。
 */

let home: string;
let workspace: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-todo-resume-"));
  workspace = await mkdtemp(join(tmpdir(), "kcode-todo-resume-ws-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

describe("todo 回注 / 续接", () => {
  it("下一轮 system 含 <todo_state>；resolveResumeHistory 恢复最新清单", async () => {
    const todoCall = {
      callId: "todo1",
      tool: "todo",
      args: {
        todos: [
          { content: "调研", status: "completed", priority: "high" },
          { content: "修复", status: "in_progress" },
        ],
      },
    };
    const llm = new ScriptedLLM([{ toolCalls: [todoCall] }, { text: "已更新" }, { text: "继续" }]);
    const session = await composeSession({
      llmFactory: async () => llm,
      model: "m",
      cwd: workspace,
      kcodeHomeDir: home,
      onEvent: () => {},
    });
    await session.loop.run("列任务");
    await session.loop.run("继续做");
    const secondSystem = llm.requests[1]?.messages[0]?.content ?? "";
    expect(secondSystem).toContain("<todo_state>");
    expect(secondSystem).toContain("修复");
    await session.close();

    const resume = await resolveResumeHistory(home, "latest", workspace);
    expect(resume).not.toBeNull();
    expect(resume?.todos.map((t) => `${t.content}:${t.status}`)).toEqual(["调研:completed", "修复:in_progress"]);

    const resumedLlm = new ScriptedLLM([{ text: "恢复" }]);
    const resumed = await composeSession({
      llmFactory: async () => resumedLlm,
      model: "m",
      cwd: workspace,
      kcodeHomeDir: home,
      sessionId: resume!.sessionId,
      resumeFrom: resume!.messages,
      resumeUsage: resume!.usage,
      resumeTodos: resume!.todos,
      resumeSubagents: resume!.subagents,
    });
    await resumed.loop.run("继续");
    expect(resumedLlm.requests[0]?.messages[0]?.content).toContain("<todo_state>");
    expect(resumedLlm.requests[0]?.messages[0]?.content).toContain("修复");
    await resumed.close();
  }, 30_000);
});

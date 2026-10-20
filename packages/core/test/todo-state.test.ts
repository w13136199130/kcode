import { describe, expect, it } from "vitest";
import type { TodoItem } from "@kcode/contracts";
import { assembleMessages } from "../src/context/assemble.js";
import { AgentLoop } from "../src/core/loop.js";
import { InMemoryToolRegistry, MemoryAudit, MemorySink, ScriptedLLM, allowAll, noHooks } from "../src/testing/index.js";

/** 3-13：todo 每轮回注 `<todo_state>`（压缩/续接后模型仍知道进度） */
describe("todo 状态注入", () => {
  it("assembleMessages：有清单才注入，标记完整", () => {
    const messages = assembleMessages({
      systemPrompt: "sys",
      todos: [
        { content: "读代码", status: "completed", priority: "high" },
        { content: "写修复", status: "in_progress", priority: "medium" },
        { content: "跑测试", status: "pending", priority: "low" },
      ],
      tools: [],
      history: [],
    });
    const system = messages[0]?.content ?? "";
    expect(system).toContain("<todo_state>");
    expect(system).toContain("- [x] ! 读代码");
    expect(system).toContain("- [~] 写修复");
    expect(system).toContain("- [ ] · 跑测试");
    expect(system).toContain("</todo_state>");
  });

  it("空清单不注入 todo_state", () => {
    const messages = assembleMessages({ systemPrompt: "sys", todos: [], tools: [], history: [] });
    expect(messages[0]?.content).not.toContain("<todo_state>");
  });

  it("loop 每轮读取最新清单（运行中更新后下一轮可见）", async () => {
    let todos: TodoItem[] = [{ content: "第一步", status: "in_progress", priority: "high" }];
    const llm = new ScriptedLLM([{ text: "a" }, { text: "b" }]);
    const loop = new AgentLoop(
      {
        llm,
        tools: new InMemoryToolRegistry([]),
        permissions: allowAll,
        hooks: noHooks,
        sink: new MemorySink(),
        audit: new MemoryAudit().sink,
        todos: () => todos,
      },
      { sessionId: "s_todo", model: "m", systemPrompt: "t", now: () => 0 },
    );
    await loop.run("第一轮");
    expect(llm.requests[0]?.messages[0]?.content).toContain("第一步");
    todos = [{ content: "第一步", status: "completed", priority: "high" }];
    await loop.run("第二轮");
    expect(llm.requests[1]?.messages[0]?.content).toContain("- [x] ! 第一步");
  });
});

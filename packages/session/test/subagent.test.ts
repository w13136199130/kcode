import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLLM, type ScriptedTurn } from "@kcode/core";
import type { SessionEvent } from "@kcode/contracts";
import { trustProject } from "@kcode/extensions";
import { composeSession } from "../src/composition.js";

let home: string;
let workspace: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-sub-home-"));
  workspace = await mkdtemp(join(tmpdir(), "kcode-sub-ws-"));
  await writeFile(join(workspace, "a.md"), "# a", "utf8");
  await writeFile(join(workspace, "b.md"), "# b", "utf8");
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

/**
 * 组合级子代理测试：llmFactory 按调用序号分发脚本——
 * 第 1 个实例是父会话，之后每个 task 调用各派生一个子代理实例。
 */
async function runWithScripts(
  scripts: ScriptedTurn[][],
  cwd = workspace,
  initialMode?: "plan" | "default",
) {
  const events: SessionEvent[] = [];
  const llms: ScriptedLLM[] = [];
  const session = await composeSession({
    llmFactory: async () => {
      const llm = new ScriptedLLM(scripts[llms.length] ?? [{ text: "（脚本耗尽）" }]);
      llms.push(llm);
      return llm;
    },
    model: "scripted/simple",
    cwd,
    kcodeHomeDir: home,
    ...(initialMode !== undefined ? { initialMode } : {}),
    onEvent: (e) => events.push(e),
  });
  await session.loop.run("开始");
  return { events, llms, session };
}

const taskCall = (type: string, prompt = "调研当前目录") => ({
  callId: "t1",
  tool: "task",
  args: { subagent_type: type, description: "调研任务", prompt },
});

describe("task 工具（B1 子代理）", () => {
  it("explore 子代理：隔离上下文执行只读工具，结论回灌父会话", async () => {
    const { events, llms, session } = await runWithScripts([
      // 父：派生 explore → 收结论后收尾
      [{ toolCalls: [taskCall("explore")] }, { text: "已汇总结论。" }],
      // 子：glob 调研 → 给出结论（末轮带 usage，供 /cost 子代理分项）
      [
        { toolCalls: [{ callId: "c1", tool: "glob", args: { pattern: "*.md" } }] },
        { text: "结论：共 2 个 md 文件（a.md、b.md）", usage: { inputTokens: 7, outputTokens: 3 } },
      ],
    ]);
    const result = events.find((e) => e.type === "tool_result" && e.callId === "t1");
    expect(result).toBeDefined();
    expect(result && result.type === "tool_result" && result.ok).toBe(true);
    expect(result?.type === "tool_result" && result.output).toContain("共 2 个 md 文件");
    expect(result?.type === "tool_result" && result.output).toContain("子代理 explore");
    // 3-13：/cost 含子代理（usageSummary 汇总 subagent_stopped 事件）
    expect(session.usageSummary().subagents).toEqual({ count: 1, inputTokens: 7, outputTokens: 3 });
    // 子代理实例确实被创建（第 2 个 ScriptedLLM），且其请求里没有父会话历史
    expect(llms.length).toBe(2);
    const childReq = llms[1]!.requests[0]!;
    expect(childReq.messages.filter((m) => m.role === "user").map((m) => m.content)).toContain("调研当前目录");
  });

  it("explore 工具集不含写工具：write 调用报 unknown tool，仍能给出结论", async () => {
    const { events } = await runWithScripts([
      [{ toolCalls: [taskCall("explore", "尝试写入并总结")] }, { text: "完成" }],
      [
        { toolCalls: [{ callId: "w1", tool: "write", args: { path: "x.txt", content: "x" } }] },
        { text: "结论：无写权限，只完成了读取" },
      ],
    ]);
    const result = events.find((e) => e.type === "tool_result" && e.callId === "t1");
    expect(result?.type === "tool_result" && result.ok).toBe(true);
    expect(result?.type === "tool_result" && result.output).toContain("无写权限");
  });

  it("未知子代理类型报可用清单", async () => {
    const { events } = await runWithScripts([
      [{ toolCalls: [taskCall("no-such-agent")] }, { text: "完成" }],
    ]);
    const result = events.find((e) => e.type === "tool_result" && e.callId === "t1");
    expect(result?.type === "tool_result" && result.ok).toBe(false);
    expect(result?.type === "tool_result" && result.error).toContain("未知子代理类型");
  });

  it("自定义子代理：.kcode/agents 定义生效（正文进系统提示、tools 子集过滤）", async () => {
    const ws2 = await mkdtemp(join(tmpdir(), "kcode-sub-ws2-"));
    await mkdir(join(ws2, ".kcode", "agents"), { recursive: true });
    await writeFile(
      join(ws2, ".kcode", "agents", "finder.md"),
      "---\ndescription: 定位标识符\ntools: read, grep\n---\n你是查找器，只返回 file:line 引用。",
      "utf8",
    );
    try {
      // 2-17：项目 agents 需 /trust 才装载
      await trustProject(ws2, join(home, "trusted-projects.json"));
      const { events, llms } = await runWithScripts(
        [
          [{ toolCalls: [taskCall("finder", "找到 a.md 的标题")] }, { text: "完成" }],
          [
            // finder 的工具集不含 glob → unknown tool；read 可用
            { toolCalls: [{ callId: "g1", tool: "glob", args: { pattern: "*.md" } }] },
            { toolCalls: [{ callId: "r1", tool: "read", args: { path: "a.md" } }] },
            { text: "结论：a.md:1 标题为 # a" },
          ],
        ],
        ws2,
      );
      // 自定义正文进入子代理系统提示
      const childSystem = llms[1]!.requests[0]!.messages[0]!;
      expect(childSystem.role).toBe("system");
      expect(childSystem.content).toContain("你是查找器");
      const result = events.find((e) => e.type === "tool_result" && e.callId === "t1");
      expect(result?.type === "tool_result" && result.ok).toBe(true);
      expect(result?.type === "tool_result" && result.output).toContain("a.md:1");
    } finally {
      await rm(ws2, { recursive: true, force: true });
    }
  });

  it("3-19 plan 档：general-purpose 被拒，explore 可用", async () => {
    const { events } = await runWithScripts(
      [
        [
          {
            toolCalls: [
              {
                callId: "t1",
                tool: "task",
                args: { subagent_type: "general-purpose", description: "写文件", prompt: "写 x" },
              },
              {
                callId: "t2",
                tool: "task",
                args: { subagent_type: "explore", description: "调研", prompt: "读 a.md" },
              },
            ],
          },
          { text: "完成" },
        ],
        [{ text: "结论：a.md 存在" }],
      ],
      workspace,
      "plan",
    );
    const general = events.find((e) => e.type === "tool_result" && e.callId === "t1");
    expect(general?.type === "tool_result" && general.ok).toBe(false);
    expect(general?.type === "tool_result" && general.error).toContain("plan");
    const explore = events.find((e) => e.type === "tool_result" && e.callId === "t2");
    expect(explore?.type === "tool_result" && explore.ok).toBe(true);
    expect(explore?.type === "tool_result" && explore.output).toContain("a.md 存在");
  });

  it("3-19 disallowedTools：从子代理工具集中剔除指定工具", async () => {
    const ws3 = await mkdtemp(join(tmpdir(), "kcode-sub-ws3-"));
    await mkdir(join(ws3, ".kcode", "agents"), { recursive: true });
    await writeFile(
      join(ws3, ".kcode", "agents", "limited.md"),
      [
        "---",
        "description: 只读受限代理",
        "tools: read, write",
        "disallowedTools: [write]",
        "maxTurns: 4",
        "---",
        "你是受限代理。",
      ].join("\n"),
      "utf8",
    );
    try {
      await trustProject(ws3, join(home, "trusted-projects.json"));
      const { events } = await runWithScripts(
        [
          [{ toolCalls: [taskCall("limited", "尝试写入")] }, { text: "完成" }],
          [
            { toolCalls: [{ callId: "w1", tool: "write", args: { path: "z.txt", content: "z" } }] },
            { text: "结论：写入被移除，仅能读取" },
          ],
        ],
        ws3,
      );
      const result = events.find((e) => e.type === "tool_result" && e.callId === "t1");
      expect(result?.type === "tool_result" && result.ok).toBe(true);
      expect(result?.type === "tool_result" && result.output).toContain("仅能读取");
    } finally {
      await rm(ws3, { recursive: true, force: true });
    }
  });
});

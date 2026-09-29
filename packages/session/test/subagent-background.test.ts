import { mkdtemp, readdir, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLLM, type ScriptedTurn } from "@kcode/core";
import type { SessionEvent, Tool } from "@kcode/contracts";
import { composeSession, SUBAGENT_NOTIFICATION_HEADER } from "../src/index.js";

let home: string;
let workspace: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-subbg-home-"));
  workspace = await mkdtemp(join(tmpdir(), "kcode-subbg-ws-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * N3D-1 集成测试：后台子代理全链路（组合级，真实 composeSession + ScriptedLLM）。
 * 脚本分发按实例创建序：#0 父会话、#1 子代理。
 */
async function runScripts(scripts: ScriptedTurn[][]) {
  const events: SessionEvent[] = [];
  let created = 0;
  const session = await composeSession({
    llmFactory: async () => {
      const llm = new ScriptedLLM(scripts[created] ?? [{ text: "（脚本耗尽）" }]);
      created += 1;
      return llm;
    },
    model: "scripted/simple",
    cwd: workspace,
    kcodeHomeDir: home,
    onEvent: (e) => events.push(e),
  });
  return { events, session };
}

const bgTaskCall = {
  callId: "t1",
  tool: "task",
  args: { subagent_type: "explore", description: "后台调研", prompt: "找出所有文件", wait: "background" },
};

describe("task wait=background（N3D-1）", () => {
  it("立即返回 → 子代理完成 → 通知注入父上下文开新 turn；事件/落盘/幂等全链路", async () => {
    const { events, session } = await runScripts([
      // 父：派生后台子代理 → 收尾本轮 →（通知到达后）第三轮收尾
      [{ toolCalls: [bgTaskCall] }, { text: "已派出后台调研" }, { text: "收到通知" }],
      // 子代理：产出结论
      [{ text: "子代理结论：共 2 个文件" }],
    ]);
    await session.loop.run("帮我调研");

    // 父轮已结束（立即回执），后台子代理异步完成 → 通知注入为新一轮
    await waitFor(() => events.some((e) => e.type === "user_message" && e.content.startsWith(SUBAGENT_NOTIFICATION_HEADER)));

    // 事件链：spawned(background) → 子代理独立落盘 → stopped(completed) → 通知 user_message → 父响应
    expect(events.some((e) => e.type === "subagent_spawned" && e.background === true)).toBe(true);
    const stopped = events.find((e) => e.type === "subagent_stopped");
    expect(stopped).toMatchObject({ status: "completed", turns: 1 });
    const notice = events.find((e) => e.type === "user_message" && e.content.startsWith(SUBAGENT_NOTIFICATION_HEADER)) as { content: string } | undefined;
    expect(notice?.content).toContain("子代理结论：共 2 个文件");

    // 注册表视图（task_output/任务面板的数据源）：终态 + 已通知（幂等）
    await waitFor(() => session.backgroundTasks().some((t) => t.id.startsWith("sub_") && t.status === "done"));
    const sub = session.backgroundTasks().find((t) => t.id.startsWith("sub_"))!;
    expect(sub.notified).toBe(true);

    // 子会话独立落盘（不污染用户会话清单）
    const subDir = join(home, "cli", "sessions", "subagents");
    const files = await readdir(subDir);
    expect(files.some((f) => f.startsWith("sub_") && f.endsWith(".jsonl"))).toBe(true);
    const subJsonl = await readFile(join(subDir, files[0]!), "utf8");
    expect(subJsonl).toContain("子代理结论：共 2 个文件");

    // 主会话目录不应出现 sub_ 文件（分组隔离）
    const mainDir = await readdir(join(home, "cli", "sessions"));
    expect(mainDir.some((f) => f.startsWith("sub_"))).toBe(false);

    await session.close();
  }, 30_000);

  it("sync 模式行为不变：阻塞回灌结论，不产生通知", async () => {
    const { events, session } = await runScripts([
      [
        { toolCalls: [{ callId: "t1", tool: "task", args: { subagent_type: "explore", description: "同步调研", prompt: "找文件" } }] },
        { text: "同步结论已回灌" },
      ],
      [{ text: "同步子代理结论" }],
    ]);
    await session.loop.run("开始");
    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "t1");
    expect(toolResult).toMatchObject({ ok: true });
    expect((toolResult as { output: string }).output).toContain("同步子代理结论");
    expect(events.some((e) => e.type === "user_message" && e.content.startsWith(SUBAGENT_NOTIFICATION_HEADER))).toBe(false);
    expect(events.some((e) => e.type === "subagent_spawned" && e.background === false)).toBe(true);
    await session.close();
  }, 30_000);
});

describe("Esc 连杀后台子代理（trackBackground）", () => {
  it("kill 回调触发子代理中断 → stopped 事件为 stopped 态", async () => {
    // 挂起工具：等 ctx.signal 中断才结算——确定性观察 kill 语义
    const hangTool: Tool = {
      definition: {
        name: "hang",
        description: "测试挂起",
        parameters: { type: "object", properties: {} },
        readOnly: true,
      },
      execute: (_input, ctx) =>
        new Promise((resolve) => {
          ctx.signal?.addEventListener("abort", () => resolve({ ok: false, output: "", error: "aborted" }));
        }),
    };
    const events: SessionEvent[] = [];
    const { buildTaskTool } = await import("../src/subagent.js");
    const kills: Array<() => void> = [];
    const tool = buildTaskTool({
      // 脚本是扁平的 ScriptedTurn[]（此前误写成嵌套数组导致空转）
      llmFactory: async () =>
        new ScriptedLLM([{ toolCalls: [{ callId: "h1", tool: "hang", args: {} }] }, { text: "不会到这" }]),
      currentModel: () => "scripted/simple",
      cwd: workspace,
      kcodeHomeDir: home,
      baseTools: [hangTool],
      // 万能桩：pre 类钩子返回不否决（HookPreOutcome），post 类无返回
      hooks: new Proxy({}, { get: () => async () => ({ veto: false }) }) as never,
      permissionFor: () => ({ decide: async () => "allow" as const }),
      agents: { get: () => undefined } as never,
      envBlock: "",
      parentSessionId: "parent",
      parentSink: { append: async (e) => { events.push(e); } },
      notify: () => {},
      trackBackground: (kill) => {
        kills.push(kill);
        return () => undefined;
      },
    });
    const started = await tool.execute(
      { subagent_type: "general-purpose", description: "挂起任务", prompt: "跑挂起工具", wait: "background" },
      { sessionId: "parent", cwd: workspace },
    );
    expect(started.ok).toBe(true);
    await waitFor(() => kills.length > 0);
    await new Promise((r) => setTimeout(r, 100)); // 让子代理进入挂起工具
    kills[0]!();
    await waitFor(() => events.some((e) => e.type === "subagent_stopped"));
    expect(events.find((e) => e.type === "subagent_stopped")).toMatchObject({ status: "stopped" });
  }, 20_000);
});

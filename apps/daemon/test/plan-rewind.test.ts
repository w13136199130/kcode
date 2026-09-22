import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLLM, type ScriptedTurn } from "@kcode/core";
import type { PlanVerdict } from "../src/plan-submit.js";
import type { SessionEvent } from "@kcode/contracts";
import { composeSession, type ComposedSession } from "../src/composition.js";

let home: string;
let workspace: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-pr-home-"));
  workspace = await mkdtemp(join(tmpdir(), "kcode-pr-ws-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

interface Harness {
  events: SessionEvent[];
  llms: ScriptedLLM[];
  session: ComposedSession;
}

/** 组合级测试：scripts 按实例序号分发（第 1 个=父会话），planVerdict 控制 plan_submit 批准结果 */
async function compose(
  scripts: ScriptedTurn[][],
  opts: { planVerdict?: PlanVerdict; planMode?: boolean; asker?: { confirm(): Promise<boolean | { allowed: boolean }> } } = {},
): Promise<Harness> {
  const events: SessionEvent[] = [];
  const llms: ScriptedLLM[] = [];
  const session = await composeSession({
    llmFactory: async () => {
      const llm = new ScriptedLLM(scripts[llms.length] ?? [{ text: "（脚本耗尽）" }]);
      llms.push(llm);
      return llm;
    },
    model: "scripted/simple",
    cwd: workspace,
    kcodeHomeDir: home,
    onEvent: (e) => events.push(e),
    asker: opts.asker ?? { confirm: async () => ({ allowed: true, scope: "once" }) },
    planAsker:
      opts.planVerdict === undefined
        ? undefined
        : { ask: async () => opts.planVerdict! },
  });
  if (opts.planMode === true) {
    session.setMode("plan");
  }
  return { events, llms, session };
}

describe("plan_submit（计划双闸门）", () => {
  it("计划模式提交并批准：工具结果成功，模式切回 default（下一请求无计划后缀）", async () => {
    const h = await compose(
      [
        [
          {
            text: "## 执行计划\n\n1. 改 A\n2. 改 B",
            toolCalls: [{ callId: "p1", tool: "plan_submit", args: { plan: "## 执行计划\n\n1. 改 A\n2. 改 B" } }],
          },
        ],
        [{ text: "按计划开始。" }],
      ],
      { planMode: true, planVerdict: "approved" },
    );
    await h.session.loop.run("帮我改造 X");
    const result = h.events.find((e) => e.type === "tool_result" && e.callId === "p1");
    expect(result?.type === "tool_result" && result.ok).toBe(true);
    expect(result?.type === "tool_result" && result.output).toContain("已获批准");
    // 批准后系统提示不再含计划模式后缀
    const lastReq = h.llms[0]!.requests.at(-1)!;
    expect((lastReq.messages[0]?.content ?? "")).not.toContain("【计划模式】");
    await h.session.close();
  });

  it("提交但要求继续研究：留在 plan 档，工具结果为失败并带指引", async () => {
    const h = await compose(
      [[{ text: "计划 v1", toolCalls: [{ callId: "p1", tool: "plan_submit", args: { plan: "计划 v1" } }] }]],
      { planMode: true, planVerdict: "revise" },
    );
    await h.session.loop.run("研究并出计划");
    const result = h.events.find((e) => e.type === "tool_result" && e.callId === "p1");
    expect(result?.type === "tool_result" && result.ok).toBe(false);
    expect(result?.type === "tool_result" && result.error).toContain("继续研究");
    const lastReq = h.llms[0]!.requests.at(-1)!;
    expect(lastReq.messages[0]?.content ?? "").toContain("【计划模式】");
    await h.session.close();
  });

  it("非计划模式调用 plan_submit：拒绝执行", async () => {
    const h = await compose([
      [{ toolCalls: [{ callId: "p1", tool: "plan_submit", args: { plan: "x" } }] }],
    ]);
    await h.session.loop.run("直接提交个计划");
    const result = h.events.find((e) => e.type === "tool_result" && e.callId === "p1");
    expect(result?.type === "tool_result" && result.ok).toBe(false);
    expect(result?.type === "tool_result" && result.error).toContain("计划模式");
    await h.session.close();
  });

  it("无交互端口（headless）：降级为未批准", async () => {
    const h = await compose([
      [{ toolCalls: [{ callId: "p1", tool: "plan_submit", args: { plan: "x" } }] }],
    ], { planMode: true });
    await h.session.loop.run("出计划");
    const result = h.events.find((e) => e.type === "tool_result" && e.callId === "p1");
    expect(result?.type === "tool_result" && result.ok).toBe(false);
    expect(result?.type === "tool_result" && result.error).toContain("无交互通道");
    await h.session.close();
  });
});

describe("/rewind（检查点回退）", () => {
  it("两轮写入后回退到第二轮之前：新文件被删除、旧文件内容恢复、历史截断", async () => {
    await writeFile(join(workspace, "keep.txt"), "原始内容", "utf8");
    // 父会话是同一个 LLM 实例：三次 run 按序消费同一条脚本
    const h = await compose([
      [
        // 第 1 轮：改 keep.txt
        { toolCalls: [{ callId: "w1", tool: "edit", args: { path: "keep.txt", oldString: "原始内容", newString: "第一轮改动" } }] },
        { text: "第一轮完成" },
        // 第 2 轮：新建 new.txt
        { toolCalls: [{ callId: "w2", tool: "write", args: { path: "new.txt", content: "第二轮新建" } }] },
        { text: "第二轮完成" },
        // 第 3 轮（回退后再跑）：验证历史不含第二轮
        { text: "第三轮。" },
      ],
    ]);
    await h.session.loop.run("第一轮：修改 keep.txt");
    await h.session.loop.run("第二轮：新建 new.txt");

    const points = await h.session.listRewindPoints();
    expect(points.length).toBeGreaterThanOrEqual(2);
    expect(points[0]!.preview).toContain("第一轮");
    expect(points[1]!.preview).toContain("第二轮");
    expect(points[0]!.fileChanges).toBe(1);
    expect(points[1]!.fileChanges).toBe(1);

    // 回退到第二轮提问之前
    const r = await h.session.rewind(points[1]!.eventIndex);
    expect(r.restoredFiles).toBe(1); // new.txt 的前像（不存在 → 删除）
    expect(existsSync(join(workspace, "new.txt"))).toBe(false);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(workspace, "keep.txt"), "utf8")).toBe("第一轮改动"); // 第一轮保留

    // 回退后历史不含第二轮提问
    await h.session.loop.run("第三轮");
    const lastReq = h.llms[0]!.requests.at(-1)!;
    const userTexts = lastReq.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(userTexts.some((t) => t.includes("第二轮"))).toBe(false);
    expect(userTexts.some((t) => t.includes("第一轮"))).toBe(true);

    // 会话关闭清理检查点目录
    await h.session.close();
  }, 20_000);
});

describe("runBash（!命令 直执行，B4）", () => {
  it("不经 LLM 直接执行并返回输出", async () => {
    const h = await compose([[{ text: "ok" }]]);
    const result = await h.session.runBash("echo b4-direct-ok");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("b4-direct-ok");
    expect(h.llms.length).toBe(1); // LLM 实例只创建了父会话一个，未因 bash 调用新增
    await h.session.close();
  });
});

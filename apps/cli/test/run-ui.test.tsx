import { EventEmitter } from "node:events";
import { render } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@kcode/contracts";
import type { LocalSessionOptions, SessionHandle } from "../src/session.js";
import type { Runtime } from "../src/bootstrap.js";
import { KcodeApp } from "../src/tui/App.js";
import { FakeTtyStdin } from "./helpers/fake-tty.js";

const bridge = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../src/session.js", () => ({ createSession: bridge.create }));
vi.mock("../src/history-store.js", () => ({
  loadInputHistory: async () => [], saveInputHistory: async () => {},
  appendHistory: (entries: string[], text: string) => [...entries, text],
}));

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/**
 * 建立真实 KcodeApp + 忠实 TTY stdin。
 *
 * 关键点（否则用例会静默挂死）：
 * - stdin 必须实现 raw 模式语义（Ink 4 走 'readable' + read() 通道，见 helpers/fake-tty.ts）；
 * - 审批交互必须经 `options.asker`——即 App 真实使用的那条链路。测试若另造一个
 *   promise 去"模拟"审批，App 的内部 ask 状态与之不同步，Ctrl+C/Esc 结算的
 *   是 App 自己那个 promise，测试持有的那个永远不会 resolve。
 */
async function setup() {
  let options!: LocalSessionOptions;
  let finish!: (summary: Awaited<ReturnType<SessionHandle["loop"]["run"]>>) => void;
  const actions: string[] = [];
  const abort = vi.fn(() => { actions.push("abort"); });
  const run = vi.fn((content: string) => {
    options.onEvent?.({ v: 1, type: "user_message", sessionId: "s1", ts: 0, content });
    return new Promise<Awaited<ReturnType<SessionHandle["loop"]["run"]>>>((resolve) => { finish = resolve; });
  });
  bridge.create.mockImplementation(async (opts: LocalSessionOptions) => {
    options = opts;
    // 句柄必须覆盖 SessionHandle 的全部方法：App 在挂载/交互期间会调用它们，
    // 缺失会抛错并被 React 静默吞掉，表现为「界面看着正常但交互不结算」。
    return {
      sessionId: "s1",
      loop: { run },
      abort,
      setMode: () => {},
      setModel: async () => null,
      models: async () => ({ providers: [] }),
      listSkills: async () => [],
      skillBody: async () => null,
      listSessions: async () => [],
      listCommands: () => [],
      expandCommand: async () => null,
      trustProject: async () => {},
      listPersistentGrants: async () => [],
      clearPersistentGrants: async () => true,
      usage: async () => null,
      rewindPoints: async () => [],
      rewind: async () => null,
      compact: async () => ({ dropped: 0, summaryChars: 0 }),
      context: async () => null,
      runBash: async () => null,
      mcpStatus: async () => [],
    } as unknown as SessionHandle;
  });
  const stdin = new FakeTtyStdin();
  const frames: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns: 120, rows: 40, isTTY: true, write: (text: string) => { frames.push(text); return true; },
  });
  const fakeRuntime = {
    models: { default: "test", providers: {} },
    keychain: { async get() { return null; }, async set() {}, async delete() {}, async list() { return []; } },
    router: {},
    kcodeHomeDir: "E:/tmp/.kcode-test",
  } as unknown as Runtime;
  const ui = render(<KcodeApp runtime={fakeRuntime} model="test" cwd="." />, {
    stdin: stdin as unknown as typeof process.stdin,
    stdout: stdout as unknown as typeof process.stdout,
    exitOnCtrlC: false, patchConsole: false,
  });
  cleanups.push(() => { ui.unmount(); stdin.destroy(); });
  const frame = () => frames.at(-1) ?? "";
  /** 等 React 提交 + Ink 出帧（帧轮询对某些状态不可靠，用固定让步更稳） */
  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (text: string) => {
    await vi.waitFor(() => expect(frame()).toContain(text), { timeout: 2500, interval: 30 });
  };
  /** 帧轮询拿不到内容时的兜底：让步若干次 */
  const eventually = async (text: string, tries = 12) => {
    for (let i = 0; i < tries; i++) {
      if (frame().includes(text)) return;
      await settle(60);
    }
    expect(frame()).toContain(text);
  };
  const send = async (text: string) => {
    stdin.write(text);
    await eventually(`${text}█`);
    stdin.write("\r");
    await eventually("等待模型响应");
  };
  const end = (status: "completed" | "aborted") => {
    options.onEvent?.({ v: 1, type: "session_end", sessionId: "s1", ts: 0, reason: status });
    finish({ sessionId: "s1", turns: 1, toolCalls: 0, status });
  };
  await eventually("> █");
  await send("go");
  return { options, actions, abort, run, stdin, frame, waitFor, eventually, settle, send, end };
}

describe("运行交互与事件状态（实际 Ink 渲染）", () => {
  // 每个用例要跑真实 Ink 渲染并串行等待多个状态文案，默认 5s 不够。
  const T = 30_000;

  it("审批中 Ctrl+C 取消整轮，重复按键不重发，实际结束后才恢复输入", async () => {
    const t = await setup();
    // 经 App 真实 asker 发起审批，测试与 UI 共用同一个 promise
    const answer = t.options.asker!.confirm({ callId: "ask1", tool: "write", args: {} });
    void answer.then(() => t.actions.push("reply"));
    await t.eventually("等待工具确认：write");
    // 帧先于 React 状态提交：交互态断言前必须让步，否则按键会打在被替换的处理器上
    await t.settle(200);

    t.stdin.write("\x03");
    await t.eventually("正在取消");
    await t.settle(100);
    await expect(answer).resolves.toEqual({ allowed: false });
    expect(t.actions).toEqual(["abort", "reply"]);
    expect(t.frame()).not.toContain("> █");

    // 重复按 Ctrl+C 不应重发 abort
    t.stdin.write("\x03");
    t.options.onDelta?.("取消后的在途增量");
    await t.eventually("取消后的在途增量");
    await t.settle(100);
    expect(t.frame()).toContain("正在取消");
    expect(t.abort).toHaveBeenCalledTimes(1);

    // 取消后的审批请求直接拒绝
    await expect(t.options.asker!.confirm({ callId: "late", tool: "bash", args: {} })).resolves.toBe(false);

    // 真正结束（session_end + run resolve）后才恢复输入
    t.end("aborted");
    await t.eventually("> █");
    await t.settle(200);
    expect(t.frame()).not.toContain("正在取消");

    await t.send("next");
    await t.settle(150);
    t.stdin.write("\x03");
    await vi.waitFor(() => expect(t.abort).toHaveBeenCalledTimes(2));
    t.end("aborted");
  }, T);

  it("审批 Esc 仅拒绝动作，不取消整轮", async () => {
    const t = await setup();
    const answer = t.options.asker!.confirm({ callId: "ask1", tool: "write", args: {} });
    await t.eventually("等待工具确认");
    await t.settle(200);

    t.stdin.write("\x1b");
    await expect(answer).resolves.toEqual({ allowed: false });
    await t.eventually("等待模型响应");
    expect(t.abort).not.toHaveBeenCalled();
    t.end("completed");
  }, T);

  it.each(["plan", "question"])("%s 面板中取消会关闭交互并结算等待", async (kind) => {
    const t = await setup();
    const question = { question: "选择下一步", options: [{ label: "继续" }] };
    let answer: Promise<string[]>;
    if (kind === "plan") {
      answer = new Promise((resolve) => {
        t.options.onPlanApproval!({ plan: "测试计划", question, reply: resolve });
      });
    } else {
      answer = t.options.askUser!.ask(question);
    }
    await t.eventually(kind === "plan" ? "等待计划批准" : "等待你的回答");
    await t.settle(200);

    t.stdin.write("\x03");
    await t.eventually("正在取消");
    await t.settle(100);
    await expect(answer).resolves.toEqual([]);
    expect(t.abort).toHaveBeenCalledTimes(1);
    expect(t.frame()).not.toContain(kind === "plan" ? "等待计划批准" : "等待你的回答");
    t.end("aborted");
  }, T);

  it("状态跟随模型增量、并行工具和终态，不提前报告执行结束", async () => {
    const t = await setup();
    t.options.onReasoning?.("分析摘要");
    await t.eventually("接收模型思考摘要");
    t.options.onDelta?.("正文");
    await t.eventually("接收模型回复");
    const event = (payload: object) => t.options.onEvent?.({ v: 1, ts: 0, sessionId: "s1", ...payload } as SessionEvent);
    event({ type: "tool_call", callId: "c1", tool: "read", args: {} });
    event({ type: "tool_call", callId: "c2", tool: "grep", args: {} });
    await t.eventually("处理工具：read、grep");
    event({ type: "tool_result", callId: "c1", ok: true, output: "ok" });
    await t.eventually("处理工具：grep");
    event({ type: "tool_result", callId: "c2", ok: true, output: "ok" });
    await t.eventually("等待模型响应");
    event({ type: "session_end", reason: "completed" });
    await t.eventually("正在结束本轮");
    expect(t.frame()).not.toContain("> █");
    t.end("completed");
    await t.eventually("> █");
  }, T);
});

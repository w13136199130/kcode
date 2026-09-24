import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@kcode/contracts";
import type { LocalSessionOptions, SessionHandle } from "../src/session.js";
import type { Runtime } from "../src/bootstrap.js";
import { KcodeApp } from "../src/tui/App.js";

const bridge = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../src/session.js", () => ({ createSession: bridge.create }));
vi.mock("../src/history-store.js", () => ({
  loadInputHistory: async () => [], saveInputHistory: async () => {},
  appendHistory: (entries: string[], text: string) => [...entries, text],
}));

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

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
    return { sessionId: "s1", loop: { run }, abort, listCommands: () => [] };
  });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
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
  const wait = async (text: string) => {
    await vi.waitFor(() => expect(frame()).toContain(text), { timeout: 2500, interval: 30 });
  };
  const send = async (text: string) => {
    stdin.write(text);
    await wait(`${text}█`);
    stdin.write("\r");
    await wait("等待模型响应");
  };
  const end = (status: "completed" | "aborted") => {
    options.onEvent?.({ v: 1, type: "session_end", sessionId: "s1", ts: 0, reason: status });
    finish({ sessionId: "s1", turns: 1, toolCalls: 0, status });
  };
  await wait("> █");
  await send("go");
  return { options, actions, abort, run, stdin, frame, wait, send, end };
}

describe("运行交互与事件状态（实际 Ink 渲染）", () => {
  // 每个用例要跑真实 Ink 渲染并串行等待多个状态文案，默认 5s 不够。
  const T = 30_000;

  it("审批中 Ctrl+C 取消整轮，重复按键不重发，实际结束后才恢复输入", async () => {
    const t = await setup();
    const answer = t.options.asker!.confirm({ callId: "ask1", tool: "write", args: {} });
    void answer.then(() => t.actions.push("reply"));
    await t.wait("等待工具确认：write");
    t.stdin.write("\x03");
    await t.wait("正在取消");
    await expect(answer).resolves.toEqual({ allowed: false });
    expect(t.actions).toEqual(["abort", "reply"]);
    expect(t.frame()).not.toContain("> █");
    t.stdin.write("\x03");
    t.options.onDelta?.("取消后的在途增量");
    await t.wait("取消后的在途增量");
    expect(t.frame()).toContain("正在取消");
    expect(t.abort).toHaveBeenCalledTimes(1);
    await expect(t.options.asker!.confirm({ callId: "late", tool: "bash", args: {} })).resolves.toBe(false);
    t.end("aborted");
    await t.wait("> █");
    expect(t.frame()).not.toContain("正在取消");
    await t.send("next");
    t.stdin.write("\x03");
    await vi.waitFor(() => expect(t.abort).toHaveBeenCalledTimes(2));
    t.end("aborted");
  }, T);

  it("审批 Esc 仅拒绝动作，不取消整轮", async () => {
    const t = await setup();
    const answer = t.options.asker!.confirm({ callId: "ask1", tool: "write", args: {} });
    await t.wait("等待工具确认");
    t.stdin.write("\x1b");
    await expect(answer).resolves.toEqual({ allowed: false });
    await t.wait("等待模型响应");
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
    await t.wait(kind === "plan" ? "等待计划批准" : "等待你的回答");
    t.stdin.write("\x03");
    await t.wait("正在取消");
    await expect(answer).resolves.toEqual([]);
    expect(t.abort).toHaveBeenCalledTimes(1);
    expect(t.frame()).not.toContain(kind === "plan" ? "等待计划批准" : "等待你的回答");
    t.end("aborted");
  }, T);

  it("状态跟随模型增量、并行工具和终态，不提前报告执行结束", async () => {
    const t = await setup();
    t.options.onReasoning?.("分析摘要");
    await t.wait("接收模型思考摘要");
    t.options.onDelta?.("正文");
    await t.wait("接收模型回复");
    const event = (payload: object) => t.options.onEvent?.({ v: 1, ts: 0, sessionId: "s1", ...payload } as SessionEvent);
    event({ type: "tool_call", callId: "c1", tool: "read", args: {} });
    event({ type: "tool_call", callId: "c2", tool: "grep", args: {} });
    await t.wait("处理工具：read、grep");
    event({ type: "tool_result", callId: "c1", ok: true, output: "ok" });
    await t.wait("处理工具：grep");
    event({ type: "tool_result", callId: "c2", ok: true, output: "ok" });
    await t.wait("等待模型响应");
    event({ type: "session_end", reason: "completed" });
    await t.wait("正在结束本轮");
    expect(t.frame()).not.toContain("> █");
    t.end("completed");
    await t.wait("> █");
  }, T);
});

import { EventEmitter } from "node:events";
import { render } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeCommandQueue } from "@kcode/runtime";
import type { LocalSessionOptions, SessionHandle } from "../src/session.js";
import type { Runtime } from "../src/bootstrap.js";
import { KcodeApp } from "../src/tui/App.js";
import { FakeTtyStdin } from "./helpers/fake-tty.js";

const bridge = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../src/session.js", () => ({ createSession: bridge.create }));
vi.mock("../src/history-store.js", () => ({
  loadInputHistory: async () => [],
  saveInputHistory: async () => {},
  appendHistory: (entries: string[], text: string) => [...entries, text],
}));

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

type RunResult = Awaited<ReturnType<SessionHandle["loop"]["run"]>>;

/**
 * N2-2 验收测试床：真实 KcodeApp + 忠实 TTY stdin + 可控 run promise。
 * run 每次调用挂起（不 resolve），由用例逐个放行——模拟多轮顺序执行。
 */
async function setup() {
  let options!: LocalSessionOptions;
  const finishers: ((r: RunResult) => void)[] = [];
  const run = vi.fn((content: string) => {
    options.onEvent?.({ v: 1, type: "user_message", sessionId: "s1", ts: 0, content });
    return new Promise<RunResult>((resolve) => { finishers.push(resolve); });
  });
  bridge.create.mockImplementation(async (opts: LocalSessionOptions) => {
    options = opts;
    return {
      sessionId: "s1",
      commandQueue: new RuntimeCommandQueue((items) => opts.onQueueChange?.(items)),
      loop: { run },
      abort: () => {},
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
    platform: { secureStorageAvailable: false, async probe() { return false; }, async saveKey() {} },
    kcodeHomeDir: "E:/tmp/.kcode-test",
  } as unknown as Runtime;
  const ui = render(<KcodeApp runtime={fakeRuntime} model="test" cwd="." />, {
    stdin: stdin as unknown as typeof process.stdin,
    stdout: stdout as unknown as typeof process.stdout,
    exitOnCtrlC: false, patchConsole: false,
  });
  cleanups.push(() => { ui.unmount(); stdin.destroy(); });
  const frame = () => frames.at(-1) ?? "";
  const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
  const eventually = async (text: string, tries = 20) => {
    for (let i = 0; i < tries; i++) {
      if (frame().includes(text)) return;
      await settle(60);
    }
    expect(frame()).toContain(text);
  };
  /** Static 滚动区断言：块打印后只在历史帧出现一次，须扫全量帧 */
  const eventuallySaw = async (text: string, tries = 25) => {
    for (let i = 0; i < tries; i++) {
      if (frames.some((f) => f.includes(text))) return;
      await settle(60);
    }
    expect(frames.some((f) => f.includes(text))).toBe(true);
  };
  /** 键入一条并回车提交（不等待运行阶段——排队场景没有新阶段可等） */
  const enter = async (text: string) => {
    stdin.write(text);
    await eventually(`${text}█`);
    stdin.write("\r");
    await settle(150);
  };
  /** 放行第 n 个挂起的 run（session_end + resolve），模拟本轮完成 */
  const finish = (n: number, status: "completed" | "aborted" = "completed") => {
    options.onEvent?.({ v: 1, type: "session_end", sessionId: "s1", ts: 0, reason: status });
    finishers[n]!({ sessionId: "s1", turns: 1, toolCalls: 0, status });
  };
  await eventually("> █");
  return { run, frame, eventually, eventuallySaw, settle, enter, finish, stdin };
}

describe("RuntimeCommandQueue 接线（N2-2：运行中入队、按序执行、中断清空）", () => {
  const T = 30_000;

  it("验收：运行中提交 3 条输入，本轮完成后按提交顺序依次执行", async () => {
    const t = await setup();
    await t.enter("first");
    await t.eventually("等待模型响应");
    await t.settle(150);

    // 运行中连发三条：不丢弃，逐条入队（busy 行排队数 1→2→3；提示块进 Static 滚动区）
    await t.enter("q2");
    await t.eventuallySaw("已排队（第 1 位）");
    await t.eventually("排队 1");
    await t.enter("q3");
    await t.eventually("排队 2");
    await t.enter("q4");
    await t.eventually("排队 3");
    expect(t.run).toHaveBeenCalledTimes(1);

    // 放行 first → q2 立即接棒；逐个放行，顺序保持 FIFO
    t.finish(0);
    await vi.waitFor(() => expect(t.run).toHaveBeenCalledTimes(2), { timeout: 3000, interval: 50 });
    t.finish(1);
    await vi.waitFor(() => expect(t.run).toHaveBeenCalledTimes(3), { timeout: 3000, interval: 50 });
    t.finish(2);
    await vi.waitFor(() => expect(t.run).toHaveBeenCalledTimes(4), { timeout: 3000, interval: 50 });
    t.finish(3);
    await t.settle(200);

    expect(t.run.mock.calls.map((c) => c[0])).toEqual(["first", "q2", "q3", "q4"]);
    // 队列排空后回到空闲输入态
    await t.eventually("> █");
  }, T);

  it("排空到 /clear 时换新会话：旧排队清空不悬挂、计数归零（换会话语义）", async () => {
    const t = await setup();
    await t.enter("first");
    await t.eventually("等待模型响应");
    await t.settle(150);
    // 斜杠命令先触发补全菜单：第一次回车=补全，第二次回车=提交
    t.stdin.write("/clear");
    await t.eventually("/clear█");
    t.stdin.write("\r");
    await t.settle(120);
    t.stdin.write("\r");
    await t.eventuallySaw("已排队（第 1 位）");
    await t.enter("after");
    await t.eventually("排队 2");

    t.finish(0); // first 完成 → 排空执行 /clear → 新会话 → "after" 属旧上下文，被清掉
    await t.eventuallySaw("已清空 1 条排队输入");
    await t.eventually("> █");
    await t.settle(300);
    expect(t.run).toHaveBeenCalledTimes(1); // "after" 未被续跑（旧队列无人排空会悬挂）
    expect(t.frame()).not.toContain("排队 1"); // 计数经旧队列 onChange 归零
  }, T);

  it("中断（Esc）清空排队输入：取消当前轮后不自动续跑", async () => {
    const t = await setup();
    await t.enter("first");
    await t.eventually("等待模型响应");
    await t.settle(150);
    await t.enter("q2");
    await t.eventuallySaw("已排队（第 1 位）");
    await t.enter("q3");
    await t.eventually("排队 2");

    t.stdin.write("\x1b"); // Esc：中断当前轮
    await t.eventuallySaw("已清空 2 条排队输入");
    t.finish(0, "aborted");
    await t.eventually("> █");
    await t.settle(300);
    expect(t.run).toHaveBeenCalledTimes(1); // q2/q3 未被续跑
  }, T);
});

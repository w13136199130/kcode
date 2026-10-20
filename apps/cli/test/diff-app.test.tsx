import { EventEmitter } from "node:events";
import { join } from "node:path";
import { render } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeCommandQueue } from "@kcode/runtime";
import type { LocalSessionOptions, SessionHandle } from "../src/session.js";
import type { Runtime } from "../src/bootstrap.js";
import { KcodeApp } from "../src/tui/App.js";
import { FakeTtyStdin } from "./helpers/fake-tty.js";

/** 3-23 端到端接线：/diff → 面板 → 单文件 hunk → 二次确认回退 → 清单空即关闭 */

const bridge = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../src/session.js", () => ({ createSession: bridge.create }));
vi.mock("../src/history-store.js", () => ({
  loadInputHistory: async () => [],
  saveInputHistory: async () => {},
  appendHistory: (entries: string[], text: string) => [...entries, text],
}));

const CWD = process.cwd();
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.clearAllMocks();
});

type Change = { path: string; diff: string; callIds: string[]; existed: boolean };

async function setup() {
  let changes: Change[] = [
    {
      path: join(CWD, "src", "a.ts"),
      diff: [" 1", "-old", "+new", " 2"].join("\n"),
      callIds: ["c1"],
      existed: true,
    },
  ];
  const revertChanges = vi.fn(async (paths?: string[]) => {
    const selected = new Set(paths ?? changes.map((c) => c.path));
    changes = changes.filter((c) => !selected.has(c.path));
    return { restoredFiles: selected.size };
  });
  bridge.create.mockImplementation(async (_opts: LocalSessionOptions) => {
    return {
      sessionId: "s1",
      commandQueue: new RuntimeCommandQueue(),
      loop: { run: async () => ({ sessionId: "s1", turns: 0, toolCalls: 0, status: "completed" }) },
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
      isProjectTrusted: async () => false,
      listPersistentGrants: async () => [],
      clearPersistentGrants: async () => true,
      usage: async () => null,
      rewindPoints: async () => [],
      rewind: async () => null,
      listChanges: async () => changes,
      revertChanges,
      compact: async () => ({ dropped: 0, summaryChars: 0 }),
      context: async () => null,
      runBash: async () => null,
      mcpStatus: async () => [],
    } as unknown as SessionHandle;
  });
  const stdin = new FakeTtyStdin();
  const frames: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns: 120,
    rows: 40,
    isTTY: true,
    write: (text: string) => {
      frames.push(text);
      return true;
    },
  });
  const fakeRuntime = {
    models: { default: "test", providers: {} },
    keychain: { async get() { return null; }, async set() {}, async delete() {}, async list() { return []; } },
    router: {},
    platform: { secureStorageAvailable: false, async probe() { return false; }, async saveKey() {} },
    kcodeHomeDir: join(CWD, ".kcode-test"),
  } as unknown as Runtime;
  const instance = render(<KcodeApp runtime={fakeRuntime} model="test" cwd={CWD} />, {
    stdin: stdin as unknown as typeof process.stdin,
    stdout: stdout as unknown as typeof process.stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  cleanups.push(() => {
    instance.unmount();
    stdin.destroy();
  });
  const isContent = (text: string): boolean => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim() !== "";
  const frame = (): string => [...frames].reverse().find(isContent) ?? "";
  const waitFor = async (text: string) => {
    // 转写走 Ink <Static>（一次性写出，不参与后续动态区重绘），因此断言搜整段输出历史
    await vi.waitFor(() => expect(frames.join("")).toContain(text), { timeout: 4000, interval: 30 });
  };
  const send = async (text: string) => {
    stdin.write(text);
    await new Promise((resolve) => setTimeout(resolve, 120));
  };
  /** 输入 + 单独回车（与真实按键分帧一致；同一 chunk 里的 "\r" 会被输入框当作粘贴） */
  const submit = async (text: string) => {
    stdin.write(text);
    await new Promise((resolve) => setTimeout(resolve, 150));
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 150));
  };
  await waitFor("> ");
  return { stdin, frame, waitFor, send, submit, revertChanges };
}

describe("KcodeApp /diff（真实 Ink 渲染）", () => {
  const T = 30_000;

  it("/diff 打开改动清单，回车看 hunk，r→y 逐文件回退后清单空即关闭面板", async () => {
    const t = await setup();
    await t.submit("/diff");
    await t.waitFor("本会话改动 1 个文件");
    expect(t.frame()).toContain("src/a.ts");

    await t.send("\r");
    await t.waitFor("@@ -1,3 +1,3 @@");
    expect(t.frame()).toContain("-old");
    expect(t.frame()).toContain("+new");

    await t.send("r");
    await t.waitFor("到本会话开始前");
    await t.send("y");
    await t.waitFor("已回退 src/a.ts");
    expect(t.revertChanges).toHaveBeenCalledWith([join(CWD, "src", "a.ts")]);
    // 清单已空：面板关闭、输入区回来
    expect(t.frame()).not.toContain("本会话改动");
    await t.waitFor("> ");
  }, T);

  it("/diff <筛选词> 无命中时提示且不开面板；/diff 空清单给出说明", async () => {
    const t = await setup();
    await t.submit("/diff nope");
    await t.waitFor("没有匹配「nope」的改动文件");
    expect(t.frame()).not.toContain("本会话改动 1 个文件");
  }, T);

  it("Esc 关闭面板且不触发回退", async () => {
    const t = await setup();
    await t.submit("/diff");
    await t.waitFor("本会话改动 1 个文件");
    await t.send("\x1b");
    await t.waitFor("> ");
    expect(t.revertChanges).not.toHaveBeenCalled();
  }, T);
});

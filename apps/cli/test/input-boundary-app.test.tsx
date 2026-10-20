import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeCommandQueue } from "@kcode/runtime";
import type { LocalSessionOptions, SessionHandle } from "../src/session.js";
import type { Runtime } from "../src/bootstrap.js";
import { KcodeApp } from "../src/tui/App.js";
import { FakeTtyStdin } from "./helpers/fake-tty.js";

/** 3-28 端到端：`#` 边界、斜杠路径、未知命令回填——真实 Ink 输入链路 */

const bridge = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../src/session.js", () => ({ createSession: bridge.create }));
vi.mock("../src/history-store.js", () => ({
  loadInputHistory: async () => [],
  saveInputHistory: async () => {},
  appendHistory: (entries: string[], text: string) => [...entries, text],
}));

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.clearAllMocks();
});

async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), "kcode-boundary-app-"));
  const runs: string[] = [];
  bridge.create.mockImplementation(async (_opts: LocalSessionOptions) => {
    return {
      sessionId: "s1",
      commandQueue: new RuntimeCommandQueue(),
      loop: {
        run: async (text: string) => {
          runs.push(text);
          return { sessionId: "s1", turns: 0, toolCalls: 0, status: "completed" };
        },
      },
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
      listChanges: async () => [],
      revertChanges: async () => ({ restoredFiles: 0 }),
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
    kcodeHomeDir: join(cwd, ".kcode-test"),
  } as unknown as Runtime;
  const instance = render(<KcodeApp runtime={fakeRuntime} model="test" cwd={cwd} />, {
    stdin: stdin as unknown as typeof process.stdin,
    stdout: stdout as unknown as typeof process.stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  cleanups.push(() => {
    instance.unmount();
    stdin.destroy();
    // Windows 上目录句柄可能晚一拍释放：清理失败不算测试失败（临时目录可留待系统回收）
    void rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  });
  const isContent = (text: string): boolean => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim() !== "";
  const frame = (): string => [...frames].reverse().find(isContent) ?? "";
  const waitFor = async (text: string) => {
    await vi.waitFor(() => expect(frames.join("")).toContain(text), { timeout: 4000, interval: 30 });
  };
  const submit = async (text: string) => {
    stdin.write(text);
    await new Promise((resolve) => setTimeout(resolve, 150));
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 200));
  };
  await vi.waitFor(() => expect(frame()).toContain("> "), { timeout: 4000 });
  return { cwd, runs, frame, waitFor, submit };
}

describe("KcodeApp 3-28 输入边界（真实 Ink 渲染）", () => {
  const T = 30_000;

  it("/Users/... 路径按普通提问进入模型", async () => {
    const t = await setup();
    await t.submit("/Users/me/project 里有什么");
    await vi.waitFor(() => expect(t.runs).toEqual(["/Users/me/project 里有什么"]));
    expect(t.frame()).not.toContain("未知命令");
  }, T);

  it("未知 /命令：提示并回填原文，不丢输入、不进模型", async () => {
    const t = await setup();
    await t.submit("/nope 参数");
    await t.waitFor("未知命令 /nope");
    await t.waitFor("原文已保留");
    expect(t.runs).toEqual([]);
    await vi.waitFor(() => expect(t.frame()).toContain("> /nope 参数"), { timeout: 4000 });
  }, T);

  it("#include 不再写 AGENTS.md，按普通提问发送", async () => {
    const t = await setup();
    await t.submit("#include <stdio.h>");
    await vi.waitFor(() => expect(t.runs).toEqual(["#include <stdio.h>"]));
    expect(existsSync(join(t.cwd, "AGENTS.md"))).toBe(false);
  }, T);
});

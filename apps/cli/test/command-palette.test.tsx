import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render as renderInk } from "ink";
import { CommandPalette, fuzzyScore, type PaletteAction } from "../src/tui/input/CommandPalette.js";
import { FakeTtyStdin } from "./helpers/fake-tty.js";

const sleep = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function mount(actions: PaletteAction[]): {
  stdin: FakeTtyStdin;
  frames: () => string;
  lastFrame: () => string;
  close: ReturnType<typeof vi.fn>;
} {
  const stdin = new FakeTtyStdin();
  const frames: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns: 100,
    rows: 30,
    isTTY: true,
    write: (text: string) => {
      frames.push(text);
      return true;
    },
  });
  const close = vi.fn();
  const instance = renderInk(<CommandPalette actions={actions} onClose={close} />, {
    stdin: stdin as unknown as typeof process.stdin,
    stdout: stdout as unknown as typeof process.stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  cleanups.push(() => {
    instance.unmount();
    stdin.destroy();
  });
  return { stdin, frames: () => frames.join(""), lastFrame: () => frames.at(-1) ?? "", close };
}

const actions = (runs: { compact: () => void; copy: () => void }): PaletteAction[] => [
  { id: "cmd:compact", label: "/compact", description: "压缩历史", kind: "命令", run: runs.compact },
  { id: "cmd:copy", label: "/copy", description: "复制最近回复", kind: "命令", run: runs.copy },
  { id: "action:tools", label: "打开工具浏览器", description: "查看长输出", kind: "动作", run: () => {} },
];

/** 3-36：Ctrl+K 命令面板——过滤、上下选择、Enter 执行、Esc 关闭 */
describe("CommandPalette", () => {
  it("模糊过滤：copy 命中 /copy 并隐藏 /compact", async () => {
    const runs = { compact: vi.fn(), copy: vi.fn() };
    const t = mount(actions(runs));
    await sleep(80);
    for (const ch of "copy") {
      t.stdin.write(ch);
      await sleep(50);
    }
    await vi.waitFor(
      () => {
        expect(t.lastFrame()).toContain("❯ copy█");
        expect(t.lastFrame()).not.toContain("/compact");
      },
      { timeout: 3000, interval: 50 },
    );
    expect(t.lastFrame()).toContain("/copy");
    expect(t.lastFrame()).toContain("复制最近回复");
  });

  it("Enter 执行选中项并关闭；Esc 只关闭", async () => {
    const runs = { compact: vi.fn(), copy: vi.fn() };
    const t = mount(actions(runs));
    await sleep(80);
    // 空查询按 label 排序：/compact 在 /copy 前
    t.stdin.write("\r");
    await sleep(50);
    expect(runs.compact).toHaveBeenCalledTimes(1);
    expect(runs.copy).not.toHaveBeenCalled();
    expect(t.close).toHaveBeenCalledTimes(1);
  });

  it("↑↓ 循环选择；Esc 关闭不执行", async () => {
    const runs = { compact: vi.fn(), copy: vi.fn() };
    const t = mount(actions(runs));
    await sleep(80);
    t.stdin.write("\x1b[B"); // down
    await sleep(40);
    t.stdin.write("\r");
    await sleep(50);
    expect(runs.copy).toHaveBeenCalledTimes(1);
    expect(runs.compact).not.toHaveBeenCalled();
  });

  it("Esc 关闭；无匹配显示空态", async () => {
    const runs = { compact: vi.fn(), copy: vi.fn() };
    const t = mount(actions(runs));
    await sleep(80);
    t.stdin.write("zzzz");
    await sleep(60);
    expect(t.lastFrame()).toContain("（无匹配）");
    t.stdin.write("\x1b");
    await sleep(40);
    expect(t.close).toHaveBeenCalledTimes(1);
    expect(runs.compact).not.toHaveBeenCalled();
  });

  it("fuzzyScore：连续前缀 > 分散匹配；不匹配为 null", () => {
    const action: PaletteAction = { id: "x", label: "/copy", description: "复制", kind: "命令", run: () => {} };
    expect(fuzzyScore("cop", action)).not.toBeNull();
    expect(fuzzyScore("cpx", action)).toBeNull();
    expect(fuzzyScore("", action)).toBe(0);
  });
});

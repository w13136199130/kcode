import { EventEmitter } from "node:events";
import { join } from "node:path";
import { render } from "ink";
import { ServicesProvider } from "@kcode/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliServices } from "../src/tui/state/services.js";
import type { DiffBrowserState } from "../src/tui/state/interactions.js";
import { DiffBrowserPanel } from "../src/tui/dialogs/DiffBrowser.js";
import { FakeTtyStdin } from "./helpers/fake-tty.js";

/** 3-23 /diff 面板：文件列表 → hunk 视图 → 逐文件回退（二次确认） */

const CWD = process.cwd();

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function mountPanel(state: DiffBrowserState) {
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
  const dialogs = {
    setDiffBrowser: vi.fn(),
    revertFile: vi.fn(async () => ({ remaining: 1 })),
    pushBlock: vi.fn(),
  };
  const services = { dialogs } as unknown as CliServices;
  const instance = render(
    <ServicesProvider services={services}>
      <DiffBrowserPanel state={state} cwd={CWD} />
    </ServicesProvider>,
    {
      stdin: stdin as unknown as typeof process.stdin,
      stdout: stdout as unknown as typeof process.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  cleanups.push(() => {
    instance.unmount();
    stdin.destroy();
  });
  /** Ink 在 mount 后先写正文、再补写 cursor-hide：跳过纯控制序列帧 */
  const frame = (): string => {
    const isContent = (text: string): boolean => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim() !== "";
    return [...frames].reverse().find(isContent) ?? "";
  };
  return {
    dialogs,
    stdin,
    frame,
    /** Ink 首帧可能在 mount 后一拍才写出：按文本轮询，避免固定 sleep 抖动 */
    waitFor: async (text: string) => {
      await vi.waitFor(() => expect(frame()).toContain(text), { timeout: 3000, interval: 30 });
    },
    send: async (text: string) => {
      stdin.write(text);
      await sleep(120);
    },
  };
}

const CHANGES = [
  {
    path: join(CWD, "src", "a.ts"),
    diff: [" 1", "-old", "+new", " 2"].join("\n"),
    callIds: ["c1"],
    existed: true,
  },
  {
    path: join(CWD, "src", "b.ts"),
    diff: ["+x", "+y"].join("\n"),
    callIds: ["c2"],
    existed: false,
  },
];

describe("DiffBrowserPanel", () => {
  it("列表列出 changed files + 增减行数 + hunk 数", async () => {
    const t = mountPanel({ changes: CHANGES });
    await t.waitFor("本会话改动 2 个文件");
    const frame = t.frame();
    expect(frame).toContain("src/a.ts");
    expect(frame).toContain("+1");
    expect(frame).toContain("-1");
    expect(frame).toContain("src/b.ts");
    expect(frame).toContain("（新建）");
    expect(frame).toContain("+2");
  });

  it("回车进入 hunk 视图（含 @@ 头与 +/- 行），Esc 回列表", async () => {
    const t = mountPanel({ changes: CHANGES });
    await t.waitFor("本会话改动 2 个文件");
    await t.send("\r");
    await t.waitFor("@@ -1,3 +1,3 @@");
    let frame = t.frame();
    expect(frame).toContain("src/a.ts");
    expect(frame).toContain("-old");
    expect(frame).toContain("+new");
    expect(frame).toContain("r 回退此文件");
    await t.send("\x1b");
    await t.waitFor("本会话改动 2 个文件");
    frame = t.frame();
    expect(frame).not.toContain("@@ -");
  });

  it("逐文件回退需二次确认：n 取消、y 调用 revertFile 并按剩余数提示", async () => {
    const t = mountPanel({ changes: CHANGES });
    await t.waitFor("本会话改动 2 个文件");
    await t.send("\x1b[B"); // ↓ 选到 b.ts
    await t.send("\r");
    await t.waitFor("📝 src/b.ts");
    await t.send("r");
    await t.waitFor("回退 src/b.ts 到本会话开始前");
    await t.send("n");
    expect(t.frame()).not.toContain("到本会话开始前");
    await t.send("r");
    await t.waitFor("到本会话开始前");
    await t.send("y");
    await vi.waitFor(() => expect(t.dialogs.revertFile).toHaveBeenCalledWith(CHANGES[1]!.path));
    expect(t.dialogs.pushBlock).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "ok", text: expect.stringContaining("已回退 src/b.ts") }),
    );
    expect(t.dialogs.pushBlock).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("剩余 1 个文件改动") }),
    );
  });

  it("/diff <文件> 唯一命中时直接进 hunk 视图，Esc 回筛选后的列表", async () => {
    const t = mountPanel({ changes: [CHANGES[0]!], query: "a.ts", focusPath: CHANGES[0]!.path });
    await t.waitFor("@@ -1,3 +1,3 @@");
    expect(t.frame()).toContain("📝 src/a.ts");
    await t.send("\x1b");
    await t.waitFor("（筛选「a.ts」）");
  });

  it("PgDn 翻页：长 diff 只渲染一页，页脚行号前进", async () => {
    const long = Array.from({ length: 40 }, (_, i) => `+line${i + 1}`).join("\n");
    const t = mountPanel({ changes: [{ path: join(CWD, "big.ts"), diff: long, callIds: ["c"], existed: true }] });
    await t.waitFor("本会话改动 1 个文件");
    await t.send("\r");
    await t.waitFor("第 1-20 行 / 共 41 行");
    await t.send("\x1b[6~"); // PgDn
    await t.waitFor("第 21-40 行 / 共 41 行");
  });

  it("超长 diff 明确提示已截断（不让用户误以为看到了全部改动）", async () => {
    const huge = `${Array.from({ length: 420 }, (_, i) => `+line${i + 1}`).join("\n")}\n…（其余 20 行省略）`;
    const t = mountPanel({ changes: [{ path: join(CWD, "huge.ts"), diff: huge, callIds: ["c"], existed: true }] });
    await t.waitFor("本会话改动 1 个文件");
    await t.send("\r");
    await t.waitFor("diff 已截断");
    expect(t.frame()).toContain("回退仍按整个文件生效");
  });

  it("Esc 关闭面板（setDiffBrowser(null)）", async () => {
    const t = mountPanel({ changes: CHANGES });
    await t.waitFor("本会话改动 2 个文件");
    await t.send("\x1b");
    expect(t.dialogs.setDiffBrowser).toHaveBeenCalledWith(null);
  });
});

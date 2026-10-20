import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render as renderInk } from "ink";
import { createUiStore } from "@kcode/ui";
import { useKeybinds } from "../src/tui/terminal/keybinds.js";
import { ToolBrowser } from "../src/tui/transcript/ToolBrowser.js";
import { FakeTtyStdin } from "./helpers/fake-tty.js";

/**
 * 工具卡片浏览器测试：
 * slice 行为（纯 store）→ 面板渲染（3-22 分页/搜索/复制/失败末尾/JSONL 路径）
 * → 键位链路（ToolBrowser + keybinds 分工：列表/详情归面板，Ctrl+B/Esc 归全局）。
 */

/** 往 store 塞一个工具块 */
function pushTool(
  store: ReturnType<typeof createUiStore>,
  callId: string,
  tool: string,
  output = "",
  status: "done" | "failed" | "running" = "done",
): void {
  store.getState().pushBlock({
    kind: "tool",
    callId,
    tool,
    argsPreview: `预览 ${callId}`,
    status,
    summary: "一行摘要",
    ...(output !== "" ? { output } : {}),
    ...(status === "running" ? {} : { durationMs: 12 }),
  });
}

function makeStore(): ReturnType<typeof createUiStore> {
  const store = createUiStore();
  pushTool(store, "c1", "bash", "第1行输出\n第2行输出");
  pushTool(store, "c2", "write", "写入完成");
  pushTool(store, "c3", "grep", "a.md\nb.md");
  return store;
}

describe("toolBrowser slice 行为", () => {
  it("打开时光标落在最近一个工具块；空会话也不越界", () => {
    const store = makeStore();
    store.getState().openToolBrowser();
    expect(store.getState().toolBrowser).toMatchObject({ open: true, cursor: 2, expandedCallId: null });

    const empty = createUiStore();
    empty.getState().openToolBrowser();
    expect(empty.getState().toolBrowser.cursor).toBe(0);
  });

  it("光标 clamp 到 [0, 工具数-1]；未打开时移动无操作", () => {
    const store = makeStore();
    store.getState().moveToolCursor(-5); // 未打开：无操作
    expect(store.getState().toolBrowser.open).toBe(false);
    store.getState().openToolBrowser();
    store.getState().moveToolCursor(-5);
    expect(store.getState().toolBrowser.cursor).toBe(0);
    store.getState().moveToolCursor(99);
    expect(store.getState().toolBrowser.cursor).toBe(2);
  });

  it("Enter 语义：展开当前卡 → 再按收起；移动光标后展开的是新卡", () => {
    const store = makeStore();
    store.getState().openToolBrowser(); // cursor=2 → c3
    store.getState().toggleToolDetail();
    expect(store.getState().toolBrowser.expandedCallId).toBe("c3");
    store.getState().toggleToolDetail();
    expect(store.getState().toolBrowser.expandedCallId).toBeNull();
    store.getState().moveToolCursor(-2); // → c1
    store.getState().toggleToolDetail();
    expect(store.getState().toolBrowser.expandedCallId).toBe("c1");
  });

  it("关闭清空展开态；resetTranscript 连浏览器一起复位", () => {
    const store = makeStore();
    store.getState().openToolBrowser();
    store.getState().toggleToolDetail();
    store.getState().closeToolBrowser();
    expect(store.getState().toolBrowser).toMatchObject({ open: false, expandedCallId: null });
    store.getState().resetTranscript();
    expect(store.getState().toolBrowser.cursor).toBe(0);
    expect(store.getState().blocks).toHaveLength(0);
  });
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const settle = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms));

function mountBrowser(store: ReturnType<typeof createUiStore>, extra: Partial<Parameters<typeof ToolBrowser>[0]> = {}) {
  const stdin = new FakeTtyStdin();
  const frames: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns: 120,
    rows: 44,
    isTTY: true,
    write: (text: string) => {
      frames.push(text);
      return true;
    },
  });
  const instance = renderInk(<ToolBrowser ui={store} {...extra} />, {
    stdin: stdin as unknown as typeof process.stdin,
    stdout: stdout as unknown as typeof process.stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  cleanups.push(() => {
    instance.unmount();
    stdin.destroy();
  });
  const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
  const isContent = (text: string): boolean => text.replace(ANSI, "").trim() !== "";
  return {
    stdin,
    frame: () => [...frames].reverse().find(isContent) ?? "",
    frames,
    send: async (text: string) => {
      stdin.write(text);
      await settle();
    },
  };
}

describe("ToolBrowser 渲染（3-22 长输出）", () => {
  it("列表带选中标记与计数头；空会话给空态提示", async () => {
    const store = makeStore();
    store.getState().openToolBrowser();
    const t = mountBrowser(store);
    await settle();
    const frame = t.frame();
    expect(frame).toContain("工具调用 3/3");
    expect(frame).toContain("❯ ✓ grep");
    expect(frame).toContain("✓ bash");
    expect(frame).toContain("Enter 展开详情");

    const empty = createUiStore();
    empty.getState().openToolBrowser();
    const e = mountBrowser(empty);
    await settle();
    expect(e.frame()).toContain("还没有工具调用");
  });

  it("展开长输出分页：首页 1-18，PgDn 到 19-36，并给出 JSONL 路径与行号", async () => {
    const store = createUiStore();
    const long = Array.from({ length: 60 }, (_, i) => `行${i + 1}`).join("\n");
    pushTool(store, "c1", "bash", long);
    store.getState().openToolBrowser();
    store.getState().toggleToolDetail();
    const t = mountBrowser(store, { jsonlPath: "C:/kcode/sessions/s1.jsonl" });
    await settle();
    expect(t.frame()).toContain("第 1-18 / 共 60 行");
    expect(t.frame()).toContain("1 │ 行1");
    expect(t.frame()).toContain("C:/kcode/sessions/s1.jsonl");
    expect(t.frame()).toContain("callId=c1");

    await t.send("\x1b[6~"); // PgDn
    expect(t.frame()).toContain("第 19-36 / 共 60 行");
    expect(t.frame()).toContain("19 │ 行19");
  });

  it("失败输出默认显示末尾；g 回顶部", async () => {
    const store = createUiStore();
    const long = Array.from({ length: 60 }, (_, i) => `行${i + 1}`).join("\n");
    pushTool(store, "c1", "bash", long, "failed");
    store.getState().openToolBrowser();
    store.getState().toggleToolDetail();
    const t = mountBrowser(store);
    await settle();
    expect(t.frame()).toContain("失败输出默认末尾");
    expect(t.frame()).toContain("60 │ 行60");
    expect(t.frame()).not.toContain("1 │ 行1");

    await t.send("g");
    expect(t.frame()).toContain("1 │ 行1");
    expect(t.frame()).not.toContain("60 │ 行60");
  });

  it("搜索过滤命中行；空查询清除", async () => {
    const store = createUiStore();
    const long = Array.from({ length: 60 }, (_, i) => `行${i + 1}`).join("\n");
    pushTool(store, "c1", "bash", long);
    store.getState().openToolBrowser();
    store.getState().toggleToolDetail();
    const t = mountBrowser(store);
    await settle();

    await t.send("/");
    await t.send("行5");
    await t.send("\r");
    expect(t.frame()).toContain("搜索「行5」命中 11 行");
    expect(t.frame()).toContain("5 │ 行5");
    expect(t.frame()).not.toContain("1 │ 行1");

    await t.send("/");
    await t.send("\x7f"); // 退格清除预填的「行5」
    await t.send("\x7f");
    await t.send("\r");
    expect(t.frame()).toContain("第 1-18 / 共 60 行");
  });

  it("c 复制完整输出并回显结果", async () => {
    const store = createUiStore();
    const text = "第一行\n第二行";
    pushTool(store, "c1", "bash", text);
    store.getState().openToolBrowser();
    store.getState().toggleToolDetail();
    const copied: string[] = [];
    const t = mountBrowser(store, { copy: (value) => (copied.push(value), true) });
    await settle();
    await t.send("c");
    expect(copied).toEqual([text]);
    const info = store.getState().blocks.at(-1);
    expect(info).toMatchObject({ kind: "info", tone: "ok" });
    expect(info?.kind === "info" ? info.text : "").toContain("已复制 2 行输出");
  });

  it("块内 2k 预览被截断时按 callId 异步加载全文", async () => {
    const store = createUiStore();
    const full = Array.from({ length: 1000 }, (_, i) => `行${i + 1}`).join("\n");
    pushTool(store, "c1", "bash", full.slice(0, 2000));
    store.getState().openToolBrowser();
    store.getState().toggleToolDetail();
    const loadOutput = vi.fn(async () => full);
    const t = mountBrowser(store, { loadOutput });
    await vi.waitFor(() => expect(t.frame()).toContain("共 1000 行"), { timeout: 2000 });
    expect(loadOutput).toHaveBeenCalledWith("c1");
  });
});

/** 挂载 useKeybinds 的最小探针：键位逻辑不依赖 App 其余部分 */
function KeybindProbe(props: { store: ReturnType<typeof createUiStore> }) {
  useKeybinds({
    busy: false,
    interactive: true,
    menuOccupied: false,
    inputEmpty: true,
    hasSession: true,
    mode: "default",
    ui: props.store,
    interruptRun: () => {},
    openRewindPicker: () => {},
    applyMode: () => {},
    exit: () => {},
    pushBlock: () => {},
  });
  return null;
}

describe("键位链路（Ctrl+B / ↑↓ / Enter / Esc 分工）", () => {
  it("Ctrl+B 打开 → 面板接管 ↑↓/Enter → Esc 先收详情，再 Esc 关闭", async () => {
    const store = makeStore();
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
    const instance = renderInk(
      <>
        <KeybindProbe store={store} />
        <ToolBrowser ui={store} />
      </>,
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

    stdin.write("\x02"); // Ctrl+B
    await settle();
    expect(store.getState().toolBrowser.open).toBe(true);
    expect(store.getState().toolBrowser.cursor).toBe(2);

    stdin.write("\x1b[A"); // ↑（ToolBrowser 接管）
    await settle();
    expect(store.getState().toolBrowser.cursor).toBe(1);

    stdin.write("\r"); // Enter → 展开 c2
    await settle();
    expect(store.getState().toolBrowser.expandedCallId).toBe("c2");

    stdin.write("\x1b"); // Esc → 收起详情，不关面板
    await settle();
    expect(store.getState().toolBrowser.expandedCallId).toBeNull();
    expect(store.getState().toolBrowser.open).toBe(true);

    stdin.write("\x1b"); // Esc → 关闭
    await settle();
    expect(store.getState().toolBrowser.open).toBe(false);
  }, 10_000);
});

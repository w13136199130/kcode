import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { render as renderInk } from "ink";
import { createUiStore } from "@kcode/ui";
import { useKeybinds } from "../src/tui/terminal/keybinds.js";
import { ToolBrowser } from "../src/tui/transcript/ToolBrowser.js";
import { FakeTtyStdin } from "./helpers/fake-tty.js";

/**
 * 工具卡片浏览器（N3C-4②）三层测试：
 * slice 行为（纯 store）→ 面板渲染（ink-testing-library）→ 键位链路（真实 Ink + FakeTtyStdin 探针）。
 */

/** 往 store 塞一个完成态工具块 */
function pushTool(store: ReturnType<typeof createUiStore>, callId: string, tool: string, output = ""): void {
  store.getState().pushBlock({
    kind: "tool",
    callId,
    tool,
    argsPreview: `预览 ${callId}`,
    status: "done",
    summary: "一行摘要",
    ...(output !== "" ? { output } : {}),
    durationMs: 12,
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

describe("ToolBrowser 渲染", () => {
  it("列表带选中标记与计数头；空会话给空态提示", () => {
    const store = makeStore();
    store.getState().openToolBrowser();
    const { lastFrame } = render(<ToolBrowser ui={store} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("工具调用 3/3");
    // 选中行带 ❯ 前缀 + 状态图标：❯ ✓ grep（最新工具块 c3 处于选中态）
    expect(frame).toContain("❯ ✓ grep");
    expect(frame).toContain("✓ bash");
    expect(frame).toContain("Enter 展开详情");

    const empty = createUiStore();
    empty.getState().openToolBrowser();
    expect(render(<ToolBrowser ui={empty} />).lastFrame()).toContain("还没有工具调用");
  });

  it("展开选中卡显示完整输出与行数截断提示", () => {
    const store = createUiStore();
    const long = Array.from({ length: 60 }, (_, i) => `行${i + 1}`).join("\n");
    pushTool(store, "c1", "bash", long);
    store.getState().openToolBrowser();
    store.getState().toggleToolDetail();
    const { lastFrame } = render(<ToolBrowser ui={store} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("行1");
    expect(frame).toContain("共 60 行");
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

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("键位链路（Ctrl+B / ↑↓ / Enter / Esc）", () => {
  it("Ctrl+B 打开 → 方向键移动 → Enter 展开 → Esc 关闭", async () => {
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
    const instance = renderInk(<KeybindProbe store={store} />, {
      stdin: stdin as unknown as typeof process.stdin,
      stdout: stdout as unknown as typeof process.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    cleanups.push(() => {
      instance.unmount();
      stdin.destroy();
    });
    const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

    stdin.write("\x02"); // Ctrl+B
    await settle();
    expect(store.getState().toolBrowser.open).toBe(true);
    expect(store.getState().toolBrowser.cursor).toBe(2);

    stdin.write("\x1b[A"); // ↑
    await settle();
    expect(store.getState().toolBrowser.cursor).toBe(1);

    stdin.write("\x1b[A\x1b[A\x1b[A"); // ↑×3 → clamp 到 0
    await settle();
    expect(store.getState().toolBrowser.cursor).toBe(0);

    stdin.write("\x1b[B"); // ↓ → 1
    await settle();
    expect(store.getState().toolBrowser.cursor).toBe(1);

    stdin.write("\r"); // Enter → 展开光标卡（c2）
    await settle();
    expect(store.getState().toolBrowser.expandedCallId).toBe("c2");

    stdin.write("\x1b"); // Esc → 关闭并清展开态
    await settle();
    expect(store.getState().toolBrowser.open).toBe(false);
    expect(store.getState().toolBrowser.expandedCallId).toBeNull();
  }, 10_000);
});

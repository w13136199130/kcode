import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { render as renderInk } from "ink";
import { ServicesProvider, createUiStore, type BgTaskView } from "@kcode/ui";
import { TaskBrowser } from "../src/tui/tasks/TaskBrowser.js";
import { useKeybinds } from "../src/tui/terminal/keybinds.js";
import { InputArea } from "../src/tui/input/InputArea.js";
import { FakeTtyStdin } from "./helpers/fake-tty.js";

/**
 * 后台任务浏览器（N3C-4③）与外部编辑器（N3C-4④）测试：
 * slice 行为 → 面板渲染（ServicesProvider 注入 getSession）→ 键位链路（FakeTtyStdin 探针）。
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function bgTask(partial: Partial<BgTaskView> & { id: string }): BgTaskView {
  return { command: "echo hi", status: "done", logPath: "unused", startedAt: Date.now(), ...partial };
}

describe("taskBrowser slice 行为", () => {
  it("打开时光标落在最近任务并按快照 clamp；两浏览器互斥", () => {
    const store = createUiStore();
    store.getState().setBackgroundTasks([bgTask({ id: "bg_1" }), bgTask({ id: "bg_2" })]);
    store.getState().openTaskBrowser();
    expect(store.getState().taskBrowser).toMatchObject({ open: true, cursor: 1, expandedId: null });

    // 互斥：开工具浏览器会收起任务浏览器，反之亦然
    store.getState().openToolBrowser();
    expect(store.getState().taskBrowser.open).toBe(false);
    expect(store.getState().toolBrowser.open).toBe(true);
    store.getState().openTaskBrowser();
    expect(store.getState().toolBrowser.open).toBe(false);
    expect(store.getState().taskBrowser.open).toBe(true);
  });

  it("光标 clamp；Enter 语义展开当前任务日志；关闭清展开态", () => {
    const store = createUiStore();
    store.getState().setBackgroundTasks([bgTask({ id: "bg_1" }), bgTask({ id: "bg_2" }), bgTask({ id: "bg_3" })]);
    store.getState().openTaskBrowser(); // cursor=2
    store.getState().moveTaskCursor(-99);
    expect(store.getState().taskBrowser.cursor).toBe(0);
    store.getState().moveTaskCursor(99);
    expect(store.getState().taskBrowser.cursor).toBe(2);
    store.getState().moveTaskCursor(-1);
    store.getState().toggleTaskDetail(); // 展开 bg_2
    expect(store.getState().taskBrowser.expandedId).toBe("bg_2");
    store.getState().closeTaskBrowser();
    expect(store.getState().taskBrowser).toMatchObject({ open: false, expandedId: null });
  });
});

describe("TaskBrowser 渲染（getSession 注入）", () => {
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "kcode-tasks-"));
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("轮询 getSession 刷新快照，列表含状态图标与选中标记；展开显示日志尾部", async () => {
    const logPath = join(home, "bg_9.log");
    await writeFile(logPath, Array.from({ length: 60 }, (_, i) => `日志行${i + 1}`).join("\n"), "utf8");
    const store = createUiStore();
    const tasks = [
      bgTask({ id: "bg_8", command: "npm run build", status: "running" }),
      bgTask({ id: "bg_9", command: "echo long-log", logPath }),
    ];
    // 先有快照再打开：光标落在最近任务（bg_9），展开即其日志尾部
    store.getState().setBackgroundTasks(tasks);
    store.getState().openTaskBrowser();
    store.getState().toggleTaskDetail();

    const { lastFrame } = render(
      <ServicesProvider services={{ getSession: () => ({ backgroundTasks: () => tasks }) }}>
        <TaskBrowser ui={store} />
      </ServicesProvider>,
    );
    await new Promise((r) => setTimeout(r, 150));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("后台任务 2/2");
    expect(frame).toContain("❯ ✓ bg_9");
    expect(frame).toContain("⚡ bg_8");
    expect(frame).toContain("npm run build");
    expect(frame).toContain("日志行60");
    expect(frame).toContain("显示尾部 40");
  }, 10_000);

  it("空任务时给可行动的空态提示", async () => {
    const store = createUiStore();
    store.getState().openTaskBrowser();
    const { lastFrame } = render(
      <ServicesProvider services={{ getSession: () => ({ backgroundTasks: () => [] }) }}>
        <TaskBrowser ui={store} />
      </ServicesProvider>,
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(lastFrame()).toContain("暂无后台任务");
  });
});

/** 键位探针：Ctrl+T/Ctrl+B 开关与互斥（keybinds 层） */
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

function mountProbe(element: JSX.Element): { stdin: FakeTtyStdin; settle(ms?: number): Promise<void> } {
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
  const instance = renderInk(element, {
    stdin: stdin as unknown as typeof process.stdin,
    stdout: stdout as unknown as typeof process.stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  cleanups.push(() => {
    instance.unmount();
    stdin.destroy();
  });
  return { stdin, settle: (ms = 120) => new Promise((r) => setTimeout(r, ms)) };
}

describe("键位链路（Ctrl+T 与互斥）", () => {
  it("Ctrl+T 打开任务浏览器 → Ctrl+T 关闭；与 Ctrl+B 互斥切换", async () => {
    const store = createUiStore();
    store.getState().setBackgroundTasks([bgTask({ id: "bg_1" })]);
    const { stdin, settle } = mountProbe(<KeybindProbe store={store} />);

    stdin.write("\x14"); // Ctrl+T
    await settle();
    expect(store.getState().taskBrowser.open).toBe(true);
    expect(store.getState().taskBrowser.cursor).toBe(0);

    stdin.write("\x02"); // Ctrl+B：互斥切到工具浏览器
    await settle();
    expect(store.getState().taskBrowser.open).toBe(false);
    expect(store.getState().toolBrowser.open).toBe(true);

    stdin.write("\x14"); // Ctrl+T 再切回
    await settle();
    expect(store.getState().toolBrowser.open).toBe(false);
    expect(store.getState().taskBrowser.open).toBe(true);

    stdin.write("\x1b"); // Esc 关闭
    await settle();
    expect(store.getState().taskBrowser.open).toBe(false);
  }, 10_000);
});

describe("外部编辑器（N3C-4④）", () => {
  const realEditor = process.env["EDITOR"];
  let editorHome: string;
  let editorScript: string;

  beforeAll(async () => {
    editorHome = await mkdtemp(join(tmpdir(), "kcode-editor-"));
    // 假编辑器 = 一个改写目标文件的小脚本（路径无空格，EDITOR 空白切分安全）；
    // argv[2] 是文件参数（argv[0]=node, argv[1]=脚本路径）
    editorScript = join(editorHome, "fake-editor.cjs");
    await writeFile(editorScript, "require('node:fs').writeFileSync(process.argv[2], '多行\\n编辑后内容')", "utf8");
  });

  afterAll(async () => {
    await rm(editorHome, { recursive: true, force: true });
  });

  afterEach(() => {
    if (realEditor === undefined) {
      delete process.env["EDITOR"];
    } else {
      process.env["EDITOR"] = realEditor;
    }
  });

  it("EDITOR 回填编辑结果（InputArea Ctrl+E 键位链路）", async () => {
    process.env["EDITOR"] = `node ${editorScript}`;
    const store = createUiStore();
    const changes: string[] = [];
    const { stdin } = mountProbe(
      <InputArea
        ui={store}
        ready={true}
        interactive={true}
        value="初始输入"
        onChange={(v) => changes.push(v)}
        onSubmit={() => {}}
        history={[]}
        commands={[]}
        cwd="."
        onCjkCommit={() => {}}
      />,
    );
    stdin.write("\x05"); // Ctrl+E
    await new Promise((r) => setTimeout(r, 500));
    expect(changes).toEqual(["多行\n编辑后内容"]);
  }, 15_000);

  it("编辑器启动失败给可读错误而非崩溃", async () => {
    process.env["EDITOR"] = "no-such-editor-cmd-xyz";
    const { openInExternalEditor } = await import("../src/tui/input/external-editor.js");
    const suspended: boolean[] = [];
    const result = await openInExternalEditor("x", {
      suspend: () => suspended.push(true),
      resume: () => suspended.push(false),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("no-such-editor-cmd-xyz");
    }
    // 失败路径也必须恢复终端状态（suspend 后必有 resume）
    expect(suspended.at(-1)).toBe(false);
  }, 15_000);
});

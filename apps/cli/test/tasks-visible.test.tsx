import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { createUiStore } from "@kcode/ui";
import type { RefObject } from "react";
import type { SessionHandle } from "../src/session.js";
import {
  newlyCompleted,
  taskSnapshotKey,
  useBackgroundTasks,
} from "../src/tui/state/status-data.js";

/** 3-27：后台任务轮询/完成铃/空闲不重绘 */

const bell = vi.hoisted(() => ({ ring: vi.fn() }));
vi.mock("../src/tui/terminal/notify.js", () => ({ ringBell: bell.ring }));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("后台任务快照纯函数", () => {
  it("指纹包含 id/状态/退出码；同内容稳定", () => {
    const tasks = [{ id: "bg_1", status: "running" }, { id: "bg_2", status: "failed", exitCode: 1 }];
    expect(taskSnapshotKey(tasks)).toBe("bg_1:running:|bg_2:failed:1");
    expect(taskSnapshotKey(tasks)).toBe(taskSnapshotKey([...tasks]));
  });

  it("只把 running → 终态算完成（重复轮询幂等）", () => {
    const known = new Map([
      ["bg_1", "running"],
      ["bg_2", "done"],
    ]);
    expect(newlyCompleted(known, [{ id: "bg_1", status: "done" }])).toEqual(["bg_1"]);
    expect(newlyCompleted(known, [{ id: "bg_1", status: "running" }])).toEqual([]);
    const after = new Map([["bg_1", "done"]]);
    expect(newlyCompleted(after, [{ id: "bg_1", status: "done" }])).toEqual([]);
  });
});

type Task = { id: string; command: string; status: "running" | "done" | "failed"; logPath: string; startedAt: number; exitCode?: number };

function Probe(props: { ui: ReturnType<typeof createUiStore>; sref: RefObject<SessionHandle | null> }) {
  useBackgroundTasks(props.ui, props.sref, true);
  return null;
}

describe("useBackgroundTasks 轮询", () => {
  it("快照进 store；状态不变不重写（空闲零重绘）；完成时响铃一次", async () => {
    const tasks: Task[] = [{ id: "bg_1", command: "npm run build", status: "running", logPath: "l", startedAt: 1 }];
    const session = { backgroundTasks: () => tasks } as unknown as SessionHandle;
    const sref = { current: session } as RefObject<SessionHandle | null>;
    const ui = createUiStore();

    render(<Probe ui={ui} sref={sref} />);
    await vi.waitFor(() => expect(ui.getState().backgroundTasks).toHaveLength(1), { timeout: 2000 });
    const first = ui.getState().backgroundTasks;
    await sleep(1100);
    expect(ui.getState().backgroundTasks).toBe(first); // 引用未变 = 没写 store

    tasks[0]!.status = "done";
    // store 持有同一对象引用，状态会立刻可见；铃声要等下一轮轮询
    await vi.waitFor(() => expect(bell.ring).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(ui.getState().backgroundTasks[0]?.status).toBe("done");

    await sleep(1100); // 下一轮不再响
    expect(bell.ring).toHaveBeenCalledTimes(1);
    expect(ui.getState().backgroundTasks[0]?.status).toBe("done");
  }, 15_000);
});

import { spawn } from "node:child_process";
import { useEffect, useState, type RefObject } from "react";
import type { BgTaskView, UiStore, UsageStats } from "@kcode/ui";
import type { SessionHandle } from "../../session.js";
import { ringBell } from "../terminal/notify.js";

/**
 * 状态栏数据源（N3C-4①）：git 分支采样与会话用量拉取。
 * 用量不走常驻轮询——busy 收尾沿（session_end → finish）与就绪时各刷一次，事件驱动零空转。
 */

/** 单次读当前分支：--no-optional-locks 避免与并发 git 操作争 index.lock；非仓库/超时/无 git 返回 null */
export function readGitBranch(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["--no-optional-locks", "symbolic-ref", "--short", "HEAD"], {
      cwd,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 3000);
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    // git 未安装 / cwd 不可访问等都走这里——状态栏少一段，不构成错误
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim() || null : null);
    });
  });
}

/** 从会话句柄拉取用量与上下文余量，写入共享 slice（CLI 与 Web 状态条同源） */
function refreshUsageStats(handle: SessionHandle | null, ui: UiStore): void {
  if (handle === null) {
    return;
  }
  void (async () => {
    const [usage, context] = await Promise.all([handle.usage(), handle.context()]);
    if (usage === null || context === null) {
      return;
    }
    ui.getState().setUsageStats({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      calls: usage.calls,
      historyTokens: context.historyTokens,
      historyBudget: context.historyBudget,
    });
  })();
}

/** git 分支采样：挂载取一次 + 60s 低频刷新（切分支后状态栏最终一致即可，无需实时） */
function useGitBranch(cwd: string): string | null {
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    const sample = (): void => {
      void readGitBranch(cwd).then((b) => {
        if (!stopped && b !== null) {
          setBranch((prev) => (prev === b ? prev : b));
        }
      });
    };
    sample();
    const timer = setInterval(sample, 60_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [cwd]);
  return branch;
}

/** 3-27：后台任务快照指纹（id+状态+退出码）——状态没变就不写 store，空闲不重绘 */
export function taskSnapshotKey(tasks: readonly { id: string; status: string; exitCode?: number }[]): string {
  return tasks.map((t) => `${t.id}:${t.status}:${t.exitCode ?? ""}`).join("|");
}

/** 3-27：本轮轮询里从 running 变为终态的任务 id（用于完成铃声，幂等） */
export function newlyCompleted(
  known: ReadonlyMap<string, string>,
  tasks: readonly { id: string; status: string }[],
): string[] {
  const out: string[] = [];
  for (const task of tasks) {
    if (known.get(task.id) === "running" && task.status !== "running") {
      out.push(task.id);
    }
  }
  return out;
}

/**
 * 3-27 后台任务可见性：会话就绪后每秒读一次注册表快照（同步内存读取，无 IO）。
 * - 指纹不变不写 store：空闲零重绘；
 * - running → done/failed 的下降沿响一次完成铃（KCODE_BELL=0 / 非 TTY 自动静音）；
 * - 状态栏 `⚙ N` 与 Ctrl+T 面板共用同一份 store 快照。
 */
export function useBackgroundTasks(
  ui: UiStore,
  sessionRef: RefObject<SessionHandle | null>,
  ready: boolean,
): void {
  useEffect(() => {
    if (!ready) {
      return;
    }
    const initial = ui.getState().backgroundTasks;
    let lastKey = taskSnapshotKey(initial);
    const known = new Map(initial.map((t) => [t.id, t.status] as const));
    let stopped = false;
    const tick = (): void => {
      const session = sessionRef.current;
      if (session === null || stopped) {
        return;
      }
      const tasks: BgTaskView[] = session.backgroundTasks?.() ?? [];
      const key = taskSnapshotKey(tasks);
      if (key !== lastKey) {
        lastKey = key;
        ui.getState().setBackgroundTasks(tasks);
      }
      if (newlyCompleted(known, tasks).length > 0) {
        // 一次轮询内多个任务同时收尾只响一声（避免连响）
        ringBell();
      }
      known.clear();
      for (const task of tasks) {
        known.set(task.id, task.status);
      }
    };
    tick();
    const timer = setInterval(tick, 1_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [ready, ui, sessionRef]);
}

/** 组合钩子：App 侧一行接线（用量订阅 + busy 收尾沿刷新 + 分支采样） */
export function useStatusStats(
  ui: UiStore,
  sessionRef: RefObject<SessionHandle | null>,
  busy: boolean,
  ready: boolean,
  cwd: string,
): { usage: UsageStats | null; branch: string | null } {
  const usage = ui((s) => s.usage);
  const branch = useGitBranch(cwd);
  useEffect(() => {
    if (!busy && ready) {
      refreshUsageStats(sessionRef.current, ui);
    }
  }, [busy, ready, ui, sessionRef]);
  return { usage, branch };
}

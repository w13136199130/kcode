import { spawn } from "node:child_process";
import { useEffect, useState, type RefObject } from "react";
import type { UiStore, UsageStats } from "@kcode/ui";
import type { SessionHandle } from "../../session.js";

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

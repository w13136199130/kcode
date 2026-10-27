import { useCallback } from "react";
import type { CreateFailure } from "../lib/switch-guards.js";

/**
 * P0-2 失败卡片动作（S0-4 从 main.tsx 原样拆出）：
 * 重试复用同一 requestId（host 侧接续 draft/failed 记录复用 sessionId）；恢复上一个任务走 onResume。
 */
export function useCreateFailureActions(opts: {
  createFailure: CreateFailure | null;
  onNewSession: (cwd: string, opts?: { requestId?: string }) => void;
  onResume: (sessionId: string, cwd?: string) => void;
}): { retryCreate: () => void; resumePreviousSession: () => void } {
  const retryCreate = useCallback((): void => {
    if (opts.createFailure === null) return;
    if (opts.createFailure.resumeFrom !== undefined) {
      opts.onResume(opts.createFailure.resumeFrom, opts.createFailure.cwd);
      return;
    }
    opts.onNewSession(
      opts.createFailure.cwd,
      opts.createFailure.requestId !== undefined ? { requestId: opts.createFailure.requestId } : undefined,
    );
  }, [opts.createFailure, opts.onNewSession, opts.onResume]);
  const resumePreviousSession = useCallback((): void => {
    if (opts.createFailure?.previousSessionId == null) return;
    opts.onResume(opts.createFailure.previousSessionId);
  }, [opts.createFailure, opts.onResume]);
  return { retryCreate, resumePreviousSession };
}

/**
 * 创建/切换链路的守卫决策与错误文案（纯函数，无依赖——renderer 与单测共用）。
 */

/** 一次失败的创建/切换：驱动主区失败卡片（重试/恢复上一任务）。 */
export interface CreateFailure {
  cwd: string;
  error: string;
  /** 幂等键：重试复用同一 requestId，host 侧可接续 draft/failed 记录复用 sessionId */
  requestId?: string;
  /** 切换前窗口里已有的会话 id——失败后可一键恢复 */
  previousSessionId: string | null;
  /** 续接目标（onResume 失败时，重试仍走续接而不是新建） */
  resumeFrom?: string;
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** host lease 拒绝（正被另一宿主持有）→ 用户能看懂、能行动的文案 */
export function describeCreateError(err: unknown): string {
  const message = errText(err);
  if (message.includes("正被另一宿主持有")) {
    return "该任务正在其他窗口使用中——先在那边结束，或稍后重试";
  }
  return message;
}

/** 运行中拦截文案；action 对应用户动作，保持与切换工作区一致的护栏语义 */
export function switchBlockedReason(action: "new" | "switch" | "workspace"): string {
  const noun = action === "new" ? "新建会话" : action === "switch" ? "切换任务" : "切换工作区";
  return `运行中不能${noun}（先停止或等待本轮完成）`;
}

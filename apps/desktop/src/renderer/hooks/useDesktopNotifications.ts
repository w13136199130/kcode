import { useEffect, useRef } from "react";

/**
 * M3a：系统通知——仅在窗口失焦时发（任务完成 / 待审批 / 待批准计划，沿检测去重）。
 * 从 main.tsx 原样搬移（P4-2 期间 main 超 500 行上限）。
 */
export function useDesktopNotifications(opts: {
  busy: boolean;
  ask: { requestId: string; tool: string } | null;
  plan: { requestId: string } | null;
}): void {
  const prevBusy = useRef(opts.busy);
  const prevAsk = useRef<string | null>(null);
  const prevPlan = useRef<string | null>(null);
  useEffect(() => {
    const focused = document.hasFocus();
    if (prevBusy.current === true && opts.busy === false && !focused) {
      window.kcodeHost?.notify("kcode", "任务已完成");
    }
    prevBusy.current = opts.busy;
    const askId = opts.ask?.requestId ?? null;
    if (askId !== null && prevAsk.current !== askId && !focused) {
      window.kcodeHost?.notify("kcode", `等待审批：${opts.ask?.tool ?? "工具"}`);
    }
    prevAsk.current = askId;
    const planId = opts.plan?.requestId ?? null;
    if (planId !== null && prevPlan.current !== planId && !focused) {
      window.kcodeHost?.notify("kcode", "等待批准执行计划");
    }
    prevPlan.current = planId;
  }, [opts.busy, opts.ask, opts.plan]);
}

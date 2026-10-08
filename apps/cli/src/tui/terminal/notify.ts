import { useEffect, useRef } from "react";

/**
 * 任务完成铃（N3F-3，对标 CC 的完成通知语义）：busy 下降沿且本轮耗时
 * ≥10s 时写一次 BEL（\a）；后台子代理完成通知到达时同触发（events.ts 调用）。
 * 取舍：不做系统级 OS 通知（属 N4 桌面）。
 * 门：stdout 非 TTY 不写；KCODE_BELL=0 显式关闭。
 */

export const BELL_MIN_BUSY_MS = 10_000;

export interface BellSink {
  write(text: string): void;
  isTTY?: boolean;
}

/** 写一次 BEL（纯副作用，门在此——单测直接喂假 sink/env） */
export function ringBell(sink: BellSink = process.stdout, env: NodeJS.ProcessEnv = process.env): void {
  if (env["KCODE_BELL"] === "0") {
    return;
  }
  if (sink.isTTY !== true) {
    return;
  }
  sink.write("\a");
}

/** busy 沿判定（纯函数便于单测）：忙→闲的下降沿且本轮满阈值才响 */
export function bellOnEdge(prevBusy: boolean, busy: boolean, startedAt: number | null, now: number): boolean {
  if (busy || !prevBusy) {
    return false;
  }
  return startedAt !== null && now - startedAt >= BELL_MIN_BUSY_MS;
}

/** TUI 挂载点：跟踪 busy 沿与本轮起点，下降沿满足阈值时响铃一次 */
export function useCompletionBell(busy: boolean, busySince: number | null, now: () => number = Date.now): void {
  const wasBusy = useRef(false);
  const startedAt = useRef<number | null>(null);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      if (startedAt.current === null) {
        startedAt.current = busySince ?? now();
      }
      return;
    }
    const start = startedAt.current;
    startedAt.current = null;
    if (bellOnEdge(wasBusy.current, false, start, now())) {
      ringBell();
    }
    wasBusy.current = false;
  }, [busy, busySince, now]);
}

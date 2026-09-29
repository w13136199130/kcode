import type { StateCreator } from "zustand";

/**
 * 运行状态 slice（N2-3 两端共享的语义层第一期）：
 * busy/排队/取消/阶段/提示——CLI 状态行与 N3 Web 状态条渲染同一份事实。
 * 单 reservation 的权威判定在 engine（RuntimeCommandQueue），本 slice 只是界面镜像 + 同步可读（getState）。
 */

/**
 * 会话用量快照（N3C-4① 状态栏常驻）：token 累计来自 SessionHandle.usage()（含 resume 种子），
 * 上下文余量来自 contextStats() 的 historyTokens/historyBudget（60% 窗口预算）。
 */
export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  historyTokens: number;
  historyBudget: number;
}

export interface RunStatusSlice {
  busy: boolean;
  busySince: number | null;
  cancelling: boolean;
  phase: string;
  notice: string | null;
  queuedCount: number;
  pendingTools: Readonly<Record<string, string>>;
  /** null = 尚无数据（会话未跑过），状态栏隐藏用量段 */
  usage: UsageStats | null;

  /** 进入一轮运行：复位取消态/待决工具/阶段，busy 置位并记录起点 */
  begin(): void;
  /** 本轮结束：busy 复位（阶段/提示保留供空闲帧展示） */
  finish(): void;
  setPhase(phase: string): void;
  setNotice(notice: string | null): void;
  setCancelling(cancelling: boolean): void;
  setQueuedCount(queuedCount: number): void;
  setPendingTool(callId: string, tool: string): void;
  clearPendingTool(callId: string): void;
  /** 本轮结束兜底：清空全部待决工具（session_end） */
  clearPendingTools(): void;
  setUsageStats(usage: UsageStats | null): void;
  /** /clear 开新会话：全部复位 */
  resetRun(): void;
}

export const createRunStatusSlice: StateCreator<RunStatusSlice, [], [], RunStatusSlice> = (set) => ({
  busy: false,
  busySince: null,
  cancelling: false,
  phase: "",
  notice: null,
  queuedCount: 0,
  pendingTools: {},
  usage: null,
  begin: () =>
    set({ busy: true, busySince: Date.now(), cancelling: false, pendingTools: {}, phase: "处理请求" }),
  finish: () => set({ busy: false, busySince: null }),
  setPhase: (phase) => set({ phase }),
  setNotice: (notice) => set({ notice }),
  setCancelling: (cancelling) => set({ cancelling }),
  setQueuedCount: (queuedCount) => set({ queuedCount }),
  setPendingTool: (callId, tool) =>
    set((state) => ({ pendingTools: { ...state.pendingTools, [callId]: tool } })),
  clearPendingTool: (callId) =>
    set((state) => {
      const pendingTools = { ...state.pendingTools };
      delete pendingTools[callId];
      return { pendingTools };
    }),
  clearPendingTools: () => set({ pendingTools: {} }),
  setUsageStats: (usage) => set({ usage }),
  resetRun: () =>
    set({
      busy: false,
      busySince: null,
      cancelling: false,
      phase: "",
      notice: null,
      queuedCount: 0,
      pendingTools: {},
      usage: null,
    }),
});

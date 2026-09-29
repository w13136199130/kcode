import type { StateCreator } from "zustand";
import type { TodoItem } from "@kcode/contracts";

/**
 * 转写 slice（N2-3）：Block 是跨端语义格式（Ink 与 DOM 渲染同一份数据，对标 ZCode 输出分层），
 * 本 slice 持有转写事实与流式缓冲。正文流式增量直接入 store（订阅组件即时重渲染）；
 * 思考摘要增量大、逐条入 store 会拖垮渲染——宿主侧用 ref 缓冲、时钟合帧搬运
 * （setReasoningDisplay），定格走 pushBlock。渲染器各自实现，格式两端共享。
 */

/** 转写块（视图模型，纯数据；渲染器各自实现，格式两端共享） */
export type Block =
  | { kind: "banner"; model: string; cwd: string }
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "reasoning"; text: string; ms?: number }
  | {
      kind: "tool";
      callId: string;
      tool: string;
      argsPreview: string;
      status: "running" | "done" | "failed";
      summary?: string;
      /** 完整输出（截断 2000 字符）：verbose 展开态渲染多行 */
      output?: string;
      /** 开始时间戳：running 态渲染动态耗时 */
      startedAt?: number;
      /** 执行耗时（完成态渲染；来自 tool_result.durationMs） */
      durationMs?: number;
    }
  | { kind: "info"; text: string; tone?: "ok" | "deny" | "warn" };

/**
 * 工具卡片浏览器状态（N3C-4②）：转写区是 Static 架构——已完成块推进 scrollback 后
 * 不再重绘，"逐卡展开"因此以覆盖层面板实现（从 blocks 数据渲染，不动 Static）。
 * 状态放共享 slice 而非组件局部：键位在宿主 keybinds 层统一处理，需与渲染解耦。
 */
export interface ToolBrowserState {
  open: boolean;
  /** 光标在工具块列表（blocks 里 kind==="tool" 的子集）中的下标 */
  cursor: number;
  /** 展开详情的工具块 callId；null = 全收起 */
  expandedCallId: string | null;
}

export interface TranscriptSlice {
  blocks: Block[];
  /** 流式正文缓冲（渲染为活区一行；flushAssistant 定格为 assistant 块） */
  streamText: string;
  /** 思考摘要的合帧显示（宿主 ref 缓冲的批量搬运结果） */
  reasoningText: string;
  todos: TodoItem[];
  toolBrowser: ToolBrowserState;

  pushBlock(block: Block): void;
  appendStream(delta: string): void;
  /** 流式正文定格为 assistant 块（空缓冲无操作） */
  flushAssistant(): void;
  /** 思考摘要合帧刷显（清空传 ""） */
  setReasoningDisplay(text: string): void;
  setTodos(todos: TodoItem[]): void;
  /** 定格某个工具块终态（tool_result 到达时补 summary/output/耗时） */
  settleTool(callId: string, patch: { status: "done" | "failed"; summary?: string; output?: string; durationMs?: number }): void;
  /** 打开工具浏览器：光标落在最近一个工具块（没有工具块也开——空态提示入口存在） */
  openToolBrowser(): void;
  closeToolBrowser(): void;
  /** 光标相对移动并 clamp 到工具块范围 */
  moveToolCursor(delta: number): void;
  /** 展开/收起当前光标工具块的详情 */
  toggleToolDetail(): void;
  resetTranscript(): void;
}

/** 工具块子集（浏览器的列表事实源） */
function toolBlocksOf(blocks: Block[]): Extract<Block, { kind: "tool" }>[] {
  return blocks.filter((b): b is Extract<Block, { kind: "tool" }> => b.kind === "tool");
}

export const createTranscriptSlice: StateCreator<TranscriptSlice, [], [], TranscriptSlice> = (set, get) => ({
  blocks: [],
  streamText: "",
  reasoningText: "",
  todos: [],
  toolBrowser: { open: false, cursor: 0, expandedCallId: null },
  pushBlock: (block) => set((state) => ({ blocks: [...state.blocks, block] })),
  appendStream: (delta) => set((state) => ({ streamText: state.streamText + delta })),
  flushAssistant: () => {
    const text = get().streamText;
    if (text === "") return;
    set((state) => ({ streamText: "", blocks: [...state.blocks, { kind: "assistant", text }] }));
  },
  setReasoningDisplay: (text) => set({ reasoningText: text }),
  setTodos: (todos) => set({ todos }),
  settleTool: (callId, patch) =>
    set((state) => ({
      blocks: state.blocks.map((b) => (b.kind === "tool" && b.callId === callId ? { ...b, ...patch } : b)),
    })),
  openToolBrowser: () =>
    set(() => ({ toolBrowser: { open: true, cursor: Math.max(0, toolBlocksOf(get().blocks).length - 1), expandedCallId: null } })),
  closeToolBrowser: () => set((state) => ({ toolBrowser: { ...state.toolBrowser, open: false, expandedCallId: null } })),
  moveToolCursor: (delta) =>
    set((state) => {
      if (!state.toolBrowser.open) return state;
      const count = toolBlocksOf(state.blocks).length;
      const cursor = Math.min(Math.max(state.toolBrowser.cursor + delta, 0), Math.max(0, count - 1));
      return { toolBrowser: { ...state.toolBrowser, cursor } };
    }),
  toggleToolDetail: () =>
    set((state) => {
      const tools = toolBlocksOf(state.blocks);
      const current = tools[state.toolBrowser.cursor];
      if (current === undefined) return state;
      const expandedCallId = state.toolBrowser.expandedCallId === current.callId ? null : current.callId;
      return { toolBrowser: { ...state.toolBrowser, expandedCallId } };
    }),
  resetTranscript: () =>
    set({ blocks: [], streamText: "", reasoningText: "", todos: [], toolBrowser: { open: false, cursor: 0, expandedCallId: null } }),
});

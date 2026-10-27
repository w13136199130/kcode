import type { HostEvent } from "@kcode/contracts";
import { isQuotaError } from "../lib/quota.js";

/**
 * 桌面时间线投影（M2a，§8.4h）：宿主事件流 → 行模型 + 直播流状态。
 * 流式 delta/reasoning 不进行列表——live-tail 单独渲染（zcode 教训：
 * running 单元移出虚拟列表，避免测高跳动）。
 */

export type Row =
  | { kind: "user"; text: string; at?: number }
  | { kind: "assistant"; text: string; at?: number }
  | { kind: "thinking"; text: string; ms?: number }
  | {
      kind: "tool";
      callId: string;
      tool: string;
      args: unknown;
      status: "running" | "done" | "failed";
      output?: string;
      error?: string;
      durationMs?: number;
      /** D2-04：host 生成的真实 preview（与审批同源） */
      preview?: { path?: string; diff: string };
      /** S1-2：长工具运行中的节流输出尾（tool_progress；不落盘，仅运行期） */
      progressTail?: string;
      progressChars?: number;
    }
  | { kind: "info"; text: string; tone?: "ok" | "deny" | "warn" }
  | { kind: "todo"; todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }
  | { kind: "separator"; label: string }
  /** P4-2（F16）：额度类 llm_error——渲染为带「重置额度/反馈」动作的内联 banner */
  | { kind: "quota"; text: string }
  /** S1-3：普通 LLM 失败（网络/超时等）——带「重试本轮」出口；retryText=失败前最后一轮用户输入 */
  | { kind: "llm_failed"; error: string; retryText?: string };

export interface TodoStep {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** 子智能体卡（P4-2/F16）：spawn/stopped 事件归并出的最新状态 */
export interface SubagentCard {
  agentId: string;
  agentType: string;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  turns?: number;
}

/** 暂停点（P4-2/F16）：单轮步数到顶 / 会话 token 预算暂停——「继续」按钮的出现依据 */
export interface PausePoint {
  reason: "limit" | "budget";
  maxTurns?: number;
  detail?: string;
}

export interface TimelineState {
  rows: Row[];
  /** 直播流（进行中的助手正文；非流式时刻为空串） */
  streamText: string;
  /** 直播思考（进行中；收起显示） */
  streamThinking: string;
  busy: boolean;
  /** 最新一轮 todo 步骤（进度卡 `2/5` 的事实源；行内仍保留历史 todo 行） */
  todos: TodoStep[];
  /** 子智能体最新状态（进度卡子智能体区的事实源） */
  agents: SubagentCard[];
  /** 暂停点：run_limit_reached / 预算 rejected 置位；用户再次输入清除 */
  paused: PausePoint | null;
  /** 最后一轮用户输入（S1-3 重试本轮的数据源） */
  lastUserText: string;
}

interface ToolRow extends Extract<Row, { kind: "tool" }> {}

/** 单个事件增量并入状态（不可变更新——React 状态语义） */
export function applyEvent(state: TimelineState, ev: HostEvent): TimelineState {
  // 顶层事件（不经 session/event 信封）
  if (ev.type === "delta") {
    return { ...state, streamText: state.streamText + (ev as { text: string }).text };
  }
  if (ev.type === "reasoning") {
    return { ...state, streamThinking: state.streamThinking + (ev as { text: string }).text };
  }
  if (ev.type === "notice") {
    const message = (ev as { message: string }).message;
    // 桌面用可操作的 TrustBanner 承载这条状态；避免同一条提示在时间线里重复。
    if (message.startsWith("项目未被信任")) return state;
    return { ...state, rows: [...state.rows, { kind: "info", text: message, tone: "warn" }] };
  }
  if (ev.type === "tool/preview") {
    return {
      ...state,
      rows: state.rows.map((row) =>
        row.kind === "tool" && row.callId === ev.callId ? { ...row, preview: ev.preview } : row,
      ),
    };
  }
  if (ev.type !== "session/event") {
    return state;
  }

  const se = (ev as { event: Record<string, unknown> }).event;
  const type = se["type"] as string;
  switch (type) {
    case "session_start":
      // 续接会在同一 JSONL 追加新的 session_start；replay 时若清空 rows，
      // 续接前的全部历史都会消失。新会话的清空由 main.tsx 的 switch/replay 负责。
      return { ...state, streamText: "", streamThinking: "" };
    case "user_message":
      return {
        ...state,
        rows: [
          ...state.rows,
          {
            kind: "user",
            text: String(se["content"] ?? ""),
            ...(typeof se["ts"] === "number" ? { at: se["ts"] } : {}),
          },
        ],
        // 用户已接手（含点「继续」）——暂停点撤销
        paused: null,
        lastUserText: String(se["content"] ?? ""),
      };
    case "assistant_message": {
      // 直播流落定成行；思考随正文落定（无独立 reasoning 事件时）
      const rows = [
        ...state.rows,
        {
          kind: "assistant",
          text: String(se["content"] ?? ""),
          ...(typeof se["ts"] === "number" ? { at: se["ts"] } : {}),
        },
      ] as Row[];
      const reasoning = se["reasoning"];
      if (typeof reasoning === "string" && reasoning !== "") {
        rows.splice(rows.length - 1, 0, { kind: "thinking", text: reasoning });
      }
      return { ...state, rows, streamText: "", streamThinking: "" };
    }
    case "tool_call": {
      const row: ToolRow = {
        kind: "tool",
        callId: String(se["callId"] ?? ""),
        tool: String(se["tool"] ?? "?"),
        args: se["args"],
        status: "running",
      };
      return { ...state, rows: [...state.rows, row] };
    }
    case "tool_result": {
      const rows = state.rows.map((r): Row => {
        if (r.kind === "tool" && r.callId === se["callId"]) {
          const { progressTail: _tail, progressChars: _chars, ...settled } = r;
          return {
            ...settled,
            status: se["ok"] === true ? "done" : "failed",
            output: typeof se["output"] === "string" ? se["output"] : undefined,
            error: typeof se["error"] === "string" ? se["error"] : undefined,
            durationMs: typeof se["durationMs"] === "number" ? se["durationMs"] : undefined,
          };
        }
        return r;
      });
      return { ...state, rows };
    }
    // S1-2：长工具进度（仅运行期事件，不落盘）——挂到对应 running 工具行
    case "tool_progress": {
      const rows = state.rows.map((r): Row =>
        r.kind === "tool" && r.callId === se["callId"] && r.status === "running"
          ? {
              ...r,
              progressTail: typeof se["tail"] === "string" ? se["tail"] : r.progressTail,
              progressChars: typeof se["totalChars"] === "number" ? se["totalChars"] : r.progressChars,
            }
          : r,
      );
      return { ...state, rows };
    }
    case "llm_error": {
      const error = String(se["error"] ?? "");
      // S2-3：code 优先（发射侧权威分类）；旧转写无 code 走文案分类兜底
      const code = typeof se["code"] === "string" ? se["code"] : undefined;
      const quota = code !== undefined ? code === "quota" : isQuotaError(error);
      const row: Row = quota
        ? { kind: "quota", text: error }
        : {
            kind: "llm_failed",
            error,
            ...(state.lastUserText !== "" ? { retryText: state.lastUserText } : {}),
          };
      return { ...state, rows: [...state.rows, row] };
    }
    case "todo_update": {
      const todos = Array.isArray(se["todos"])
        ? (se["todos"] as Array<{ content: string; status: "pending" | "in_progress" | "completed" }>)
        : [];
      return { ...state, rows: [...state.rows, { kind: "todo", todos }], todos };
    }
    case "skill_used":
      return {
        ...state,
        rows: [...state.rows, { kind: "info", text: `▸ 已注入技能 ${String(se["skill"] ?? "")}（${String(se["trigger"] ?? "")}）`, tone: "ok" }],
      };
    case "permission_decision": {
      const decision = String(se["decision"] ?? "");
      if (decision === "allow" || decision === "ask-allowed") return state; // 常态放行不刷屏
      return {
        ...state,
        rows: [...state.rows, { kind: "info", text: `🔐 ${String(se["tool"] ?? "")}：${decision}${se["detail"] !== undefined ? `（${String(se["detail"])}）` : ""}`, tone: "deny" }],
      };
    }
    case "compaction_summary":
      return {
        ...state,
        rows: [
          ...state.rows,
          { kind: "separator", label: `上下文已压缩（丢弃 ${String(se["dropped"] ?? 0)} 条）` },
        ],
      };
    case "subagent_spawned": {
      const card: SubagentCard = {
        agentId: String(se["agentId"] ?? ""),
        agentType: String(se["agentType"] ?? ""),
        description: String(se["description"] ?? ""),
        status: "running",
      };
      return {
        ...state,
        rows: [...state.rows, { kind: "info", text: `🤖 子代理 ${card.agentType}：${card.description}`, tone: "ok" }],
        agents: state.agents.some((a) => a.agentId === card.agentId)
          ? state.agents.map((a) => (a.agentId === card.agentId ? card : a))
          : [...state.agents, card],
      };
    }
    case "subagent_stopped": {
      const agentId = String(se["agentId"] ?? "");
      const status = String(se["status"] ?? "stopped");
      const stopped: SubagentCard = {
        agentId,
        agentType: String(se["agentType"] ?? ""),
        description: String(se["description"] ?? ""),
        status: status === "completed" || status === "failed" ? status : "stopped",
        ...(typeof se["turns"] === "number" ? { turns: se["turns"] } : {}),
      };
      return {
        ...state,
        rows: [...state.rows, { kind: "info", text: `🤖 子代理结束（${status}，${String(se["turns"] ?? 0)} 轮）`, tone: "warn" }],
        agents: state.agents.some((a) => a.agentId === agentId)
          ? state.agents.map((a) => (a.agentId === agentId ? { ...a, ...stopped } : a))
          : [...state.agents, stopped],
      };
    }
    case "session_end": {
      const reason = se["reason"];
      const detail = typeof se["detail"] === "string" ? se["detail"] : undefined;
      const rows =
        reason === "completed"
          ? state.rows
          : [...state.rows, { kind: "info", text: `⏸ 本轮结束（${String(reason)}）`, tone: "warn" } as Row];
      let paused = state.paused;
      if (reason === "limit_reached") {
        paused = paused ?? { reason: "limit" };
      } else if (reason === "rejected" && detail !== undefined && detail.startsWith("会话 token 预算已用尽")) {
        paused = { reason: "budget", detail };
      } else if (reason === "completed") {
        paused = null;
      }
      return { ...state, rows, paused, busy: false, streamText: "", streamThinking: "" };
    }
    case "run_limit_reached":
      return {
        ...state,
        rows: [...state.rows, { kind: "info", text: "⏸ 已达单轮步数上限，输入「继续」可接着做", tone: "warn" }],
        paused: {
          reason: "limit",
          ...(typeof se["maxTurns"] === "number" ? { maxTurns: se["maxTurns"] } : {}),
        },
      };
    default:
      return state;
  }
}

export function initialTimeline(): TimelineState {
  return { rows: [], streamText: "", streamThinking: "", busy: false, todos: [], agents: [], paused: null, lastUserText: "" };
}

/** 工具参数的一行预览（argsPreview 桌面版——command/path/query 等首字段） */
export function toolArgsPreview(tool: string, args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const a = args as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const v = a[key];
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const first =
    pick("command") ?? pick("path") ?? pick("pattern") ?? pick("query") ?? pick("url") ?? pick("name") ?? pick("prompt");
  if (first !== undefined) {
    const oneLine = first.split("\\n")[0]!.split("\n")[0]!;
    return oneLine.length > 72 ? `${oneLine.slice(0, 72)}…` : oneLine;
  }
  const json = JSON.stringify(args);
  if (json !== undefined && json.length > 2) {
    return json.length > 72 ? `${json.slice(0, 72)}…` : json;
  }
  return tool;
}

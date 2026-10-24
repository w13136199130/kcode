import type { HostEvent } from "@kcode/contracts";

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
    }
  | { kind: "info"; text: string; tone?: "ok" | "deny" | "warn" }
  | { kind: "todo"; todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }
  | { kind: "separator"; label: string };

export interface TimelineState {
  rows: Row[];
  /** 直播流（进行中的助手正文；非流式时刻为空串） */
  streamText: string;
  /** 直播思考（进行中；收起显示） */
  streamThinking: string;
  busy: boolean;
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
    return { ...state, rows: [...state.rows, { kind: "info", text: (ev as { message: string }).message, tone: "warn" }] };
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
          return {
            ...r,
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
    case "llm_error":
      return { ...state, rows: [...state.rows, { kind: "info", text: `✗ 模型调用失败：${String(se["error"] ?? "")}`, tone: "warn" }] };
    case "todo_update": {
      const todos = Array.isArray(se["todos"])
        ? (se["todos"] as Array<{ content: string; status: "pending" | "in_progress" | "completed" }>)
        : [];
      return { ...state, rows: [...state.rows, { kind: "todo", todos }] };
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
    case "subagent_spawned":
      return {
        ...state,
        rows: [...state.rows, { kind: "info", text: `🤖 子代理 ${String(se["agentType"] ?? "")}：${String(se["description"] ?? "")}`, tone: "ok" }],
      };
    case "subagent_stopped":
      return {
        ...state,
        rows: [...state.rows, { kind: "info", text: `🤖 子代理结束（${String(se["status"] ?? "")}，${String(se["turns"] ?? 0)} 轮）`, tone: "warn" }],
      };
    case "session_end": {
      const reason = se["reason"];
      const rows =
        reason === "completed"
          ? state.rows
          : [...state.rows, { kind: "info", text: `⏸ 本轮结束（${String(reason)}）`, tone: "warn" } as Row];
      return { ...state, rows, busy: false, streamText: "", streamThinking: "" };
    }
    case "run_limit_reached":
      return { ...state, rows: [...state.rows, { kind: "info", text: "⏸ 已达单轮步数上限，输入「继续」可接着做", tone: "warn" }] };
    default:
      return state;
  }
}

export function initialTimeline(): TimelineState {
  return { rows: [], streamText: "", streamThinking: "", busy: false };
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

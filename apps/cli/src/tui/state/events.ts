import type { MutableRefObject } from "react";
import type { SessionEvent } from "@kcode/contracts";
import type { UiStore } from "@kcode/ui";
import { formatToolPreview } from "../transcript/Transcript.js";
import type { StreamController } from "./stream.js";

/**
 * 会话事件 → 转写块/运行状态（N2-3 外迁）：纯映射，无 React 状态依赖。
 */
export function makeEventHandler(deps: {
  ui: UiStore;
  stream: StreamController;
  /** 手动 /skill 注入：下一轮 user_message 不整段回显（事件仍落盘 JSONL） */
  suppressNextUserBlock: MutableRefObject<boolean>;
}): (event: SessionEvent) => void {
  const { ui, stream, suppressNextUserBlock } = deps;
  const pushBlock = ui.getState().pushBlock;
  return (event: SessionEvent) => {
    switch (event.type) {
      case "user_message":
        ui.getState().setPhase("等待模型响应");
        if (suppressNextUserBlock.current) {
          suppressNextUserBlock.current = false;
          break;
        }
        pushBlock({ kind: "user", text: event.content });
        break;
      case "tool_call":
        ui.getState().setPendingTool(event.callId, event.tool);
        ui.getState().setPhase("等待模型响应");
        stream.flushStream();
        pushBlock({
          kind: "tool",
          callId: event.callId,
          tool: event.tool,
          argsPreview: formatToolPreview(event.tool, event.args),
          status: "running",
          startedAt: Date.now(),
        });
        break;
      case "tool_result":
        ui.getState().clearPendingTool(event.callId);
        ui.getState().setPhase("等待模型响应");
        {
          const full = event.output !== "" ? event.output : (event.error ?? "");
          const summary = full.split("\n")[0]?.slice(0, 120) ?? "";
          ui.getState().settleTool(event.callId, {
            status: event.ok ? "done" : "failed",
            summary,
            output: full.slice(0, 2000),
            ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          });
        }
        break;
      case "assistant_message":
        if (ui.getState().streamText !== "") {
          stream.flushStream();
        } else {
          pushBlock({ kind: "assistant", text: event.content });
        }
        break;
      case "compaction_summary":
        pushBlock({ kind: "info", text: `⑂ ${event.summary}` });
        break;
      case "run_limit_reached":
        pushBlock({
          kind: "info",
          tone: "warn",
          text: `⏸ 已达单轮步数上限（${event.maxTurns} 步，防失控保护）。上下文已保留，输入「继续」可接着做`,
        });
        break;
      case "llm_error":
        stream.flushStream();
        pushBlock({ kind: "info", tone: "warn", text: `✗ 模型调用失败：${event.error}` });
        break;
      case "session_end":
        ui.getState().clearPendingTools();
        ui.getState().setPhase("正在结束本轮");
        if (event.reason !== "completed") {
          stream.flushStream();
          const labels = { failed: "本轮执行失败", aborted: "已取消本轮执行", limit_reached: "已达到运行上限，任务可能未完成", rejected: "输入被 user_prompt_submit 钩子拒绝" };
          pushBlock({ kind: "info", tone: "warn", text: labels[event.reason] + (event.detail ? "：" + event.detail : "") });
        }
        break;
      case "todo_update":
        ui.getState().setTodos(event.todos);
        break;
      case "skill_used":
        pushBlock({
          kind: "info",
          text: `📖 技能 ${event.skill} 已加载（${event.trigger === "auto" ? "自动触发" : "手动"}）`,
        });
        break;
      default:
        break;
    }
  };
}

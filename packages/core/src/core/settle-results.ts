import type { ChatMessage, SessionEvent, Tool, ToolOutput } from "@kcode/contracts";
import { capToolResult } from "../context/budget.js";
import type { PendingCall } from "./executor.js";

/**
 * 工具结果回填（自 loop.ts 抽出为独立模块，N3D-2 行数治理）：
 * tool_result 事件落盘 + 历史副本（B3 micro 截断——发给模型的副本超预算截头尾保留，
 * JSONL 事件仍为全文）+ extract 图片挂载（带图 user 消息，视觉模型可看，上限 3 张）。
 */
export async function settleToolResults(dep: {
  calls: PendingCall[];
  results: { result: ToolOutput; durationMs: number }[];
  tools: Tool[];
  emit: (event: SessionEvent) => Promise<void>;
  pushHistory: (message: ChatMessage) => void;
  sessionId: string;
  toolResultBudget: number;
  ts: () => number;
}): Promise<void> {
  const defByName = new Map(dep.tools.map((t) => [t.definition.name, t.definition] as const));
  for (let i = 0; i < dep.calls.length; i++) {
    const call = dep.calls[i]!;
    const { result, durationMs } = dep.results[i]!;
    await dep.emit({
      v: 1,
      type: "tool_result",
      ts: dep.ts(),
      sessionId: dep.sessionId,
      callId: call.callId,
      ok: result.ok,
      output: result.output,
      ...(result.error !== undefined ? { error: result.error } : {}),
      durationMs,
    });
    dep.pushHistory({
      role: "tool",
      // B3 micro：发给模型的副本超预算截断（头尾保留）；JSONL 事件仍为全文
      content: capToolResult(
        result.output !== "" ? result.output : (result.error ?? ""),
        defByName.get(call.tool)?.resultBudget ?? dep.toolResultBudget,
      ),
      toolCallId: call.callId,
      name: call.tool,
    });
    // extract 图片挂载：以带图 user 消息注入（ChatMessage.images 既有通道），
    // 视觉模型可直接查看；文本模型忽略。成本护栏：最多 3 张。
    if (result.imagePaths !== undefined && result.imagePaths.length > 0) {
      dep.pushHistory({
        role: "user",
        content: `<tool_image tool="extract">${result.imagePaths.join("\n")}</tool_image>（工具挂载的图片，供视觉查看）`,
        images: result.imagePaths.slice(0, 3),
      });
    }
  }
}

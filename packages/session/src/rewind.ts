import type { AgentLoop } from "@kcode/core";
import type { SessionSink } from "@kcode/contracts";
import { effectiveEvents, loadSessionEvents, rebuildHistory } from "@kcode/runtime";
import type { CheckpointStore } from "./checkpoints.js";

/**
 * /rewind 回退实现（自 composition 外迁，N2-5 拆分）：恢复写前像 + append-only 截断标记 + 截断重建历史。
 * 回退点下标基于有效前缀（连续回退两次时，第二次的下标不再对应整个文件）。
 */
export async function rewindTo(opts: {
  eventIndex: number;
  jsonlPath: string;
  sessionId: string;
  busy: boolean;
  checkpoints: CheckpointStore;
  sink: SessionSink;
  loop: AgentLoop;
  onNotice?: (message: string) => void;
}): Promise<{ restoredFiles: number; droppedEvents: number }> {
  if (opts.busy) {
    throw new Error("运行中不能回退（等待本轮完成或 Esc 中断）");
  }
  const { eventIndex, jsonlPath, sessionId, checkpoints, sink, loop } = opts;
  const all = await loadSessionEvents(jsonlPath);
    // 回退点下标基于**有效前缀**（连续回退两次时，第二次的下标不再对应整个文件）
    const events = effectiveEvents(all);
    const target = events[eventIndex];
    if (target === undefined || target.type !== "user_message") {
      throw new Error("回退点无效");
    }
    if (eventIndex === events.length) {
      throw new Error("该提问已是最后一个回退点");
    }
    // 恢复该提问起的全部写/编辑前像（store 内部按逆序回滚）
    const callIds = events
      .slice(eventIndex)
      .filter(
        (e): e is Extract<(typeof events)[number], { type: "tool_call" }> =>
          e.type === "tool_call" && (e.tool === "write" || e.tool === "edit"),
      )
      .map((e) => e.callId)
      .filter((id) => checkpoints.get(id) !== undefined);
    const restoredFiles = await checkpoints.restore(callIds);
    // M1-02：回退必须落盘，否则重启后被回退内容复活。
    // 写成 append-only 的截断标记（含有效前缀长度），经 sink 同时通知 UI 与落盘。
    await sink.append({
      v: 1,
      type: "session_rewind",
      ts: Date.now(),
      sessionId,
      keepEvents: eventIndex,
      restoredFiles,
    });
    loop.replaceHistory(rebuildHistory(events.slice(0, eventIndex)));
    const droppedEvents = events.length - eventIndex;
    opts.onNotice?.(`已回退：恢复 ${restoredFiles} 个文件 · 对话截断 ${droppedEvents} 个事件`);
    return { restoredFiles, droppedEvents };
}

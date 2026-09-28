import { describe, expect, it } from "vitest";
import { createUiStore } from "../src/state/store.js";

describe("UI 语义 store（N2-3：run-status + transcript 双 slice）", () => {
  it("run-status：begin/finish 与各置位动作", () => {
    const s = createUiStore();
    expect(s.getState().busy).toBe(false);
    s.getState().begin();
    expect(s.getState().busy).toBe(true);
    expect(s.getState().busySince).not.toBeNull();
    expect(s.getState().phase).toBe("处理请求");
    s.getState().setPendingTool("c1", "bash");
    s.getState().setPendingTool("c2", "read");
    s.getState().clearPendingTool("c1");
    expect(s.getState().pendingTools).toEqual({ c2: "read" });
    s.getState().setQueuedCount(3);
    s.getState().setCancelling(true);
    s.getState().setNotice("正在取消");
    expect(s.getState().queuedCount).toBe(3);
    expect(s.getState().cancelling).toBe(true);
    s.getState().finish();
    expect(s.getState().busy).toBe(false);
    expect(s.getState().busySince).toBeNull();
    // finish 不清提示/排队——空闲帧仍要展示；resetRun 才全清
    expect(s.getState().notice).toBe("正在取消");
    s.getState().resetRun();
    expect(s.getState().notice).toBeNull();
    expect(s.getState().queuedCount).toBe(0);
  });

  it("begin 复位上一轮残留：取消态/待决工具（排队数不归零——权威在 commandQueue.onChange）", () => {
    const s = createUiStore();
    s.getState().begin();
    s.getState().setCancelling(true);
    s.getState().setPendingTool("c1", "bash");
    s.getState().setQueuedCount(2);
    s.getState().finish();
    s.getState().begin();
    expect(s.getState().cancelling).toBe(false);
    expect(s.getState().pendingTools).toEqual({});
    expect(s.getState().queuedCount).toBe(2);
  });

  it("transcript：流式正文 append 与 flushAssistant 定格；思考走宿主合帧通道", () => {
    const s = createUiStore();
    s.getState().appendStream("你");
    s.getState().appendStream("好");
    expect(s.getState().streamText).toBe("你好");
    s.getState().setReasoningDisplay("思考中");
    s.getState().pushBlock({ kind: "reasoning", text: "思考中", ms: 42 });
    s.getState().flushAssistant();
    expect(s.getState().streamText).toBe("");
    const kinds = s.getState().blocks.map((b) => b.kind);
    expect(kinds).toEqual(["reasoning", "assistant"]);
    expect(s.getState().blocks[0]).toMatchObject({ kind: "reasoning", text: "思考中", ms: 42 });
    expect(s.getState().blocks[1]).toMatchObject({ kind: "assistant", text: "你好" });
  });

  it("run-status：clearPendingTools 兜底清空", () => {
    const s = createUiStore();
    s.getState().setPendingTool("a", "bash");
    s.getState().setPendingTool("b", "read");
    s.getState().clearPendingTools();
    expect(s.getState().pendingTools).toEqual({});
  });

  it("transcript：settleTool 定格工具终态，resetTranscript 全清", () => {
    const s = createUiStore();
    s.getState().pushBlock({ kind: "tool", callId: "c1", tool: "bash", argsPreview: "ls", status: "running" });
    s.getState().settleTool("c1", { status: "done", summary: "ok", durationMs: 120 });
    expect(s.getState().blocks[0]).toMatchObject({ status: "done", summary: "ok", durationMs: 120 });
    s.getState().setTodos([{ content: "t", status: "in_progress", priority: "high" }]);
    s.getState().resetTranscript();
    expect(s.getState().blocks).toEqual([]);
    expect(s.getState().todos).toEqual([]);
  });

  it("工厂隔离：两个 store 实例互不串态", () => {
    const a = createUiStore();
    const b = createUiStore();
    a.getState().pushBlock({ kind: "user", text: "x" });
    expect(b.getState().blocks).toEqual([]);
  });
});

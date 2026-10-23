import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { createUiStore } from "@kcode/ui";
import { TranscriptView } from "../src/tui/transcript/TranscriptView.js";

/**
 * 3-25 Static 边界：
 * - 运行中工具后面插入 info（排队提示/子代理事件）时，工具卡仍留在活区，终态可重绘；
 * - Ctrl+O（renderEpoch + verbose）让已进入 Static 的块按新展开度重放；
 * - /clear（resetTranscript）后 Static 下标复位，新块不会被跳过。
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("TranscriptView Live/Static 边界（3-25）", () => {
  it("running 工具后插入 info：工具卡不被冻结，完成后能画出 ✓", async () => {
    const store = createUiStore();
    store.getState().pushBlock({
      kind: "tool",
      callId: "c1",
      tool: "bash",
      argsPreview: "npm test",
      status: "running",
      startedAt: Date.now(),
    });
    store.getState().pushBlock({ kind: "info", text: "⧗ 已排队（第 1 位）" });
    const instance = render(<TranscriptView ui={store} verbose={false} tick={Date.now()} />);
    await sleep(100);
    const initial = instance.frames.join("");
    expect(initial).toContain("⚡ bash");
    expect(initial).toContain("⧗ 已排队");

    store.getState().settleTool("c1", { status: "done", summary: "全部通过", durationMs: 120 });
    await sleep(120);
    const after = instance.frames.join("");
    // 旧实现：running 卡先被推进 Static，终态永远不会再画出来
    expect(after).toContain("✓ bash");
    expect(after).toContain("全部通过");
    instance.unmount();
  }, 10_000);

  it("Ctrl+O 展开：当前轮活区就地重绘，不重放 Static 历史", async () => {
    const store = createUiStore();
    store.getState().pushBlock({ kind: "user", text: "解释一下" });
    store.getState().pushBlock({ kind: "reasoning", text: "内部推演细节", ms: 1000 });
    const instance = render(<TranscriptView ui={store} verbose={false} tick={0} />);
    await sleep(100);
    const collapsed = instance.frames.join("");
    expect(collapsed).toContain("Thought for 1.0s (ctrl+o to expand)");
    expect(collapsed).not.toContain("内部推演细节");

    // 只切 verbose，不调用 replayTranscript：最近一轮在活区，直接重绘。
    instance.rerender(<TranscriptView ui={store} verbose tick={0} />);
    await sleep(120);
    expect(instance.frames.join("")).toContain("内部推演细节");
    instance.unmount();
  }, 10_000);

  it("终端宽度内的大表格按纵向记录渲染，不再被 Ink 任意折行", async () => {
    const store = createUiStore();
    store.getState().pushBlock({ kind: "user", text: "对比" });
    store.getState().pushBlock({
      kind: "assistant",
      text: [
        "| 应用 | 职责 | 入口 | 构建 | 产物 | 说明 |",
        "| --- | --- | --- | --- | --- | --- |",
        "| cli | 终端界面 | main.tsx | tsup | dist | 可分发 |",
        "| host | 子进程宿主 | port.ts | tsup | port.cjs | 被两端消费 |",
      ].join("\n"),
    });
    const instance = render(<TranscriptView ui={store} verbose={false} tick={0} />);
    await sleep(100);
    const text = instance.frames.join("");
    expect(text).toContain("▎ cli");
    expect(text).toContain("职责: 终端界面");
    expect(text).toContain("说明: 被两端消费");
    instance.unmount();
  }, 10_000);

  it("/clear 后 Static 复位：新会话的块不会被旧下标跳过", async () => {
    const store = createUiStore();
    store.getState().pushBlock({ kind: "info", text: "旧会话内容" });
    const instance = render(<TranscriptView ui={store} verbose={false} tick={0} />);
    await sleep(100);
    expect(instance.frames.join("")).toContain("旧会话内容");

    store.getState().resetTranscript();
    store.getState().pushBlock({ kind: "info", text: "新会话第一条" });
    await sleep(120);
    expect(instance.frames.join("")).toContain("新会话第一条");
    instance.unmount();
  }, 10_000);

  it("3-34 失败工具卡未按 Ctrl+O 也默认展示末尾输出", async () => {
    const store = createUiStore();
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`);
    store.getState().pushBlock({
      kind: "tool",
      callId: "fail1",
      tool: "bash",
      argsPreview: "npm test",
      status: "failed",
      output: lines.join("\n"),
      summary: "exit 1",
    });
    const instance = render(<TranscriptView ui={store} verbose={false} tick={0} />);
    await sleep(100);
    const text = instance.frames.join("");
    expect(text).toContain("line-20");
    expect(text).toContain("仅显示末尾 6 行");
    instance.unmount();
  }, 10_000);
});

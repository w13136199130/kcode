import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@kcode/contracts";
import { SUBAGENT_NOTIFICATION_HEADER } from "@kcode/session";
import { replayBlocks } from "../src/tui/state/replay.js";

const ev = (event: Record<string, unknown>): SessionEvent =>
  ({ v: 1, ts: 0, sessionId: "s", ...event }) as SessionEvent;

describe("3-01 resume 转写回放", () => {
  it("重建 user/assistant/reasoning/tool 行，tool_result 落到对应 callId", () => {
    const blocks = replayBlocks([
      ev({ type: "user_message", content: "修一下测试" }),
      ev({ type: "assistant_message", content: "先读文件", reasoning: "需要看实现" }),
      ev({ type: "tool_call", callId: "c1", tool: "read", args: { path: "a.ts" } }),
      ev({ type: "tool_result", callId: "c1", ok: true, output: "line1\nline2", durationMs: 12 }),
      ev({ type: "assistant_message", content: "改好了" }),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["user", "reasoning", "assistant", "tool", "assistant"]);
    const tool = blocks.find((b) => b.kind === "tool");
    expect(tool).toMatchObject({ callId: "c1", status: "done", output: "line1\nline2", durationMs: 12 });
  });

  it("失败工具保留错误、压缩与子代理通知转 info", () => {
    const blocks = replayBlocks([
      ev({ type: "tool_call", callId: "c2", tool: "bash", args: { command: "false" } }),
      ev({ type: "tool_result", callId: "c2", ok: false, output: "boom" }),
      ev({ type: "compaction_summary", summary: "摘要", dropped: 3 }),
      ev({ type: "user_message", content: `${SUBAGENT_NOTIFICATION_HEADER}\n后台完成` }),
    ]);
    expect(blocks.find((b) => b.kind === "tool")).toMatchObject({ status: "failed", summary: "boom" });
    expect(blocks.some((b) => b.kind === "info" && b.text.includes("摘要"))).toBe(true);
    expect(blocks.some((b) => b.kind === "info" && b.text.includes("后台完成"))).toBe(true);
  });

  it("超长转写截断为最近 120 块并提示省略", () => {
    const events = Array.from({ length: 150 }, (_, i) =>
      ev({ type: "user_message", content: `q${i}` }),
    );
    const blocks = replayBlocks(events);
    expect(blocks).toHaveLength(121);
    expect(blocks[0]).toMatchObject({ kind: "info" });
    expect(blocks[0]?.kind === "info" && blocks[0].text).toContain("省略");
  });
});

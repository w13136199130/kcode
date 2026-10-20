import { describe, expect, it } from "vitest";
import type { HostEvent } from "@kcode/contracts";
import { applyEvent, initialTimeline } from "../src/renderer/components/projection.js";

describe("D2-04 tool/preview 投影", () => {
  it("preview 按 callId 挂到工具行，tool_result 之后仍保留", () => {
    let state = initialTimeline();
    state = applyEvent(state, {
      type: "session/event",
      event: { v: 1, type: "tool_call", ts: 1, sessionId: "s", callId: "c1", tool: "edit", args: { path: "a.ts" } },
    } as HostEvent);
    state = applyEvent(state, {
      type: "tool/preview",
      callId: "c1",
      preview: { path: "a.ts", diff: " a\n-b\n+c" },
    } as HostEvent);
    let row = state.rows.find((r) => r.kind === "tool");
    expect(row?.kind === "tool" && row.preview?.diff).toContain("-b");

    state = applyEvent(state, {
      type: "session/event",
      event: { v: 1, type: "tool_result", ts: 2, sessionId: "s", callId: "c1", ok: true, output: "ok" },
    } as HostEvent);
    row = state.rows.find((r) => r.kind === "tool");
    expect(row?.kind === "tool" && row.status).toBe("done");
    expect(row?.kind === "tool" && row.preview?.path).toBe("a.ts");
  });
});

import { describe, expect, it } from "vitest";
import type { AuditRecord } from "@kcode/core";
import { formatAuditRecords } from "../src/tui/input/audit-view.js";

/** 3-29：/audit 展示（工具/裁决/scope/耗时/详情，不可信文本剥离） */
describe("formatAuditRecords", () => {
  it("逐条展示时间/tool/decision/scope/duration/detail", () => {
    const records: AuditRecord[] = [
      {
        ts: Date.UTC(2026, 9, 20, 4, 5, 6),
        sessionId: "s",
        callId: "c1",
        tool: "bash",
        decision: "ask-allowed",
        scope: "project",
        durationMs: 12,
        detail: "user allowed",
      },
      { ts: 0, sessionId: "s", callId: "c2", tool: "read", decision: "deny" },
    ];
    const text = formatAuditRecords(records, "/tmp/audit.jsonl");
    expect(text).toContain("最近 2 条");
    expect(text).toContain("bash · ask-allowed scope=project · 12ms · user allowed");
    expect(text).toContain("read · deny");
    expect(text).toContain("/tmp/audit.jsonl");
  });

  it("空记录给出路径", () => {
    expect(formatAuditRecords([], "/tmp/a.jsonl")).toContain("/tmp/a.jsonl");
  });
});

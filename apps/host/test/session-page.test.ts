import { describe, expect, it } from "vitest";
import { pageSessions } from "../src/session-page.js";
import type { SummaryRow } from "../src/session-summaries.js";

function row(i: number): SummaryRow {
  return {
    sessionId: `sess_${String(i).padStart(3, "0")}`,
    filePath: `sess_${i}.jsonl`,
    modifiedAt: 1_000 - i,
    turns: 1,
    preview: i === 0 ? "深层历史会话" : `普通会话 ${i}`,
    workspaceKey: "E:/space/a",
  };
}

describe("session-page", () => {
  it("filters query before default slice", () => {
    const rows = Array.from({ length: 205 }, (_, i) => row(i));
    const page = pageSessions({
      summaries: rows,
      indexed: [],
      archived: new Set(),
      deleted: new Set(),
      query: "深层历史",
      limit: 100,
      offset: 0,
    });
    expect(page.total).toBe(1);
    expect(page.sessions[0]?.sessionId).toBe("sess_000");
    expect(page.hasMore).toBe(false);
  });

  it("paginates without duplicates", () => {
    const rows = Array.from({ length: 205 }, (_, i) => row(i));
    const first = pageSessions({
      summaries: rows,
      indexed: [],
      archived: new Set(),
      deleted: new Set(),
      query: "",
      limit: 100,
      offset: 0,
    });
    const second = pageSessions({
      summaries: rows,
      indexed: [],
      archived: new Set(),
      deleted: new Set(),
      query: "",
      limit: 100,
      offset: 100,
    });
    expect(first.total).toBe(205);
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(true);
    const ids = new Set([...first.sessions, ...second.sessions].map((s) => s.sessionId));
    expect(ids.size).toBe(200);
  });

  it("index metadata fills missing workspaceKey and draft is retained", () => {
    const page = pageSessions({
      summaries: [{ ...row(1), workspaceKey: "" }],
      indexed: [
        {
          sessionId: "sess_001",
          workspaceKey: "E:/space/index",
          createdAt: 1,
          updatedAt: 2,
        },
        {
          sessionId: "sess_draft",
          workspaceKey: "E:/space/index",
          createdAt: 3,
          updatedAt: 3,
          status: "draft",
          ungrouped: true,
        },
      ],
      archived: new Set(),
      deleted: new Set(),
      query: "",
      limit: 100,
      offset: 0,
    });
    expect(page.sessions.find((s) => s.sessionId === "sess_001")?.workspaceKey).toBe("E:/space/index");
    expect(page.sessions.find((s) => s.sessionId === "sess_draft")?.draft).toBe(true);
    expect(page.sessions.find((s) => s.sessionId === "sess_draft")?.ungrouped).toBe(true);
  });
});

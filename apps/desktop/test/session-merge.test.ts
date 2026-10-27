import { describe, expect, it } from "vitest";
import { mergeSessionSources } from "../src/renderer/lib/session-merge.js";

const current = { id: null, workspace: "", preview: "" };

describe("P3-2 session merge authority", () => {
  it("host workspaceKey wins over conflicting local cwd", () => {
    const rows = mergeSessionSources(
      [{ sessionId: "sess_a", preview: "host", turns: 1, modifiedAt: 10, workspaceKey: "E:/host" }],
      [{ sessionId: "sess_a", cwd: "E:/local", createdAt: 1, preview: "local" }],
      current,
    );
    expect(rows[0]).toMatchObject({ workspaceKey: "E:/host", preview: "host" });
  });

  it("local fills only missing host fields", () => {
    const rows = mergeSessionSources(
      [{ sessionId: "sess_a", preview: "", turns: 0, modifiedAt: 10, workspaceKey: "" }],
      [{ sessionId: "sess_a", cwd: "E:/local", createdAt: 1, preview: "local preview" }],
      current,
    );
    expect(rows[0]).toMatchObject({ workspaceKey: "E:/local", preview: "local preview", turns: 1 });
  });

  it("keeps local-only rows as fallback and adds current draft", () => {
    const rows = mergeSessionSources(
      [],
      [{ sessionId: "sess_local", cwd: "E:/local", createdAt: 2, preview: "local" }],
      { id: "sess_current", workspace: "E:/current", preview: "" },
    );
    expect(rows.map((row) => row.sessionId)).toEqual(["sess_current", "sess_local"]);
    expect(rows[0]).toMatchObject({ workspaceKey: "E:/current", preview: "" });
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findSessionIndexByRequest,
  listSessionIndex,
  patchSessionIndex,
  reconcileSessionIndex,
  upsertSessionIndex,
} from "../src/session-index.js";

const homes: string[] = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "kcode-session-index-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("session-index", () => {
  it("upserts, deduplicates and preserves createdAt", async () => {
    const home = await tempHome();
    await upsertSessionIndex(home, {
      sessionId: "sess_a",
      workspaceKey: "E:/space/a",
      createdAt: 100,
    });
    await upsertSessionIndex(home, {
      sessionId: "sess_b",
      workspaceKey: "E:/space/b",
      createdAt: 200,
    });
    await upsertSessionIndex(home, {
      sessionId: "sess_a",
      workspaceKey: "E:/space/a",
      preview: "你好",
      updatedAt: 300,
    });
    const sessions = await listSessionIndex(home);
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.sessionId === "sess_a")).toMatchObject({
      workspaceKey: "E:/space/a",
      createdAt: 100,
      updatedAt: 300,
      preview: "你好",
    });
  });

  it("finds a create request for idempotent retry", async () => {
    const home = await tempHome();
    await upsertSessionIndex(home, {
      sessionId: "sess_request",
      workspaceKey: "E:/space/a",
      requestId: "req_1",
      status: "draft",
    });
    expect((await findSessionIndexByRequest(home, "req_1"))?.sessionId).toBe("sess_request");
    await upsertSessionIndex(home, {
      sessionId: "sess_request",
      workspaceKey: "E:/space/a",
      requestId: "req_1",
      status: "active",
    });
    expect((await findSessionIndexByRequest(home, "req_1"))?.status).toBe("active");
    expect(await findSessionIndexByRequest(home, "req_missing")).toBeUndefined();
  });

  it("tolerates corrupt JSON", async () => {
    const home = await tempHome();
    await mkdir(join(home, "desktop"), { recursive: true });
    await writeFile(join(home, "desktop", "session-index.json"), "{bad", "utf8");
    expect(await listSessionIndex(home)).toEqual([]);
  });

  it("removes stale draft/failed entries but keeps recent drafts", async () => {
    const home = await tempHome();
    const old = Date.now() - 25 * 60 * 60_000;
    await upsertSessionIndex(home, {
      sessionId: "sess_old_draft",
      workspaceKey: "E:/space/a",
      status: "draft",
      updatedAt: old,
    });
    await upsertSessionIndex(home, {
      sessionId: "sess_recent_draft",
      workspaceKey: "E:/space/a",
      status: "draft",
      updatedAt: Date.now(),
    });
    await reconcileSessionIndex(home, []);
    expect((await listSessionIndex(home)).map((item) => item.sessionId)).toEqual(["sess_recent_draft"]);
  });

  it("writes a complete JSON document", async () => {
    const home = await tempHome();
    await upsertSessionIndex(home, { sessionId: "sess_a", workspaceKey: "E:/space/a" });
    const raw = await readFile(join(home, "desktop", "session-index.json"), "utf8");
    expect(JSON.parse(raw)).toMatchObject({ version: 1 });
  });

  it("reconciles actual summaries and patch title", async () => {
    const home = await tempHome();
    await upsertSessionIndex(home, { sessionId: "sess_a", workspaceKey: "E:/space/a" });
    await reconcileSessionIndex(home, [
      { sessionId: "sess_a", workspaceKey: "E:/space/a", modifiedAt: 500, preview: "你好", title: "任务 A" },
      { sessionId: "sess_b", workspaceKey: "E:/space/b", modifiedAt: 600, preview: "旧会话" },
      { sessionId: "sess_unkeyed", workspaceKey: "", modifiedAt: 700, preview: "无归属" },
    ]);
    const sessions = await listSessionIndex(home);
    expect(sessions.find((s) => s.sessionId === "sess_a")).toMatchObject({
      preview: "你好",
      title: "任务 A",
      updatedAt: 500,
    });
    expect(sessions.find((s) => s.sessionId === "sess_b")).toMatchObject({ preview: "旧会话" });
    expect(sessions.some((s) => s.sessionId === "sess_unkeyed")).toBe(false);
    await patchSessionIndex(home, "sess_a", { title: "改名" });
    expect((await listSessionIndex(home)).find((s) => s.sessionId === "sess_a")?.title).toBe("改名");
  });
});

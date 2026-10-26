import { describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionSummaryCache } from "../src/session-summaries.js";

function jsonl(events: Array<Record<string, unknown>>): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

/** Windows mtime 分辨率可能粗于写入间隔：显式拨 mtime 保证双键失效可观测。 */
async function touch(path: string, at: number): Promise<void> {
  await utimes(path, new Date(at), new Date(at));
}

async function setup(): Promise<{ dir: string; cache: SessionSummaryCache }> {
  const root = await mkdtemp(join(tmpdir(), "kcode-summaries-"));
  const dir = join(root, "sessions");
  await mkdir(dir, { recursive: true });
  return { dir, cache: new SessionSummaryCache(dir) };
}

describe("会话摘要增量缓存（P1-1）", () => {
  it("头部提取 session_start/首条 user_message/标题 sidecar", async () => {
    const { dir, cache } = await setup();
    const now = Date.now();
    await writeFile(
      join(dir, "sess_a.jsonl"),
      jsonl([
        { v: 1, type: "session_start", ts: now, sessionId: "sess_a", workspaceKey: "E:/ws/kcode" },
        { v: 1, type: "user_message", ts: now + 1, sessionId: "sess_a", content: "修复桌面宿主启动失败的问题" },
        { v: 1, type: "assistant_message", ts: now + 2, sessionId: "sess_a", content: "ok" },
      ]),
      "utf8",
    );
    await writeFile(join(dir, "sess_a.title"), "桌面宿主修复\n", "utf8");

    const rows = await cache.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "sess_a",
      workspaceKey: "E:/ws/kcode",
      preview: "修复桌面宿主启动失败的问题".slice(0, 60),
      turns: 1,
      title: "桌面宿主修复",
    });
    await rm(dir, { recursive: true, force: true });
  });

  it("未变化文件零重读；追加/改标题才失效", async () => {
    const { dir, cache } = await setup();
    const file = join(dir, "sess_b.jsonl");
    const title = join(dir, "sess_b.title");
    const now = Date.now();
    await writeFile(
      file,
      jsonl([
        { v: 1, type: "session_start", ts: now, sessionId: "sess_b", workspaceKey: "E:/ws" },
        { v: 1, type: "user_message", ts: now + 1, sessionId: "sess_b", content: "第一问" },
      ]),
      "utf8",
    );
    await writeFile(title, "旧标题\n", "utf8");

    await cache.list();
    const readsAfterFirst = cache.headReads;
    // 连续多次列表（30s 轮询 + sessions/changed 重拉）：未变文件不重读
    await cache.list();
    await cache.list();
    expect(cache.headReads).toBe(readsAfterFirst);

    // 只改标题 sidecar：主文件不重读，标题更新
    await writeFile(title, "新标题\n", "utf8");
    await touch(title, Date.now() + 5000);
    let rows = await cache.list();
    expect(cache.headReads).toBe(readsAfterFirst);
    expect(rows[0]?.title).toBe("新标题");

    // 追加消息（size 变化）：摘要更新
    await appendFile(file, `${JSON.stringify({ v: 1, type: "user_message", ts: Date.now(), sessionId: "sess_b", content: "第二问" })}\n`, "utf8");
    await touch(file, Date.now() + 6000);
    rows = await cache.list();
    expect(cache.headReads).toBe(readsAfterFirst + 1);
    expect(rows[0]).toMatchObject({ turns: 2, title: "新标题" });
    await rm(dir, { recursive: true, force: true });
  });

  it("文件删除后缓存清理；空文件/坏文件不列出", async () => {
    const { dir, cache } = await setup();
    const file = join(dir, "sess_c.jsonl");
    const now = Date.now();
    await writeFile(
      file,
      jsonl([
        { v: 1, type: "session_start", ts: now, sessionId: "sess_c", workspaceKey: "" },
        { v: 1, type: "user_message", ts: now + 1, sessionId: "sess_c", content: "临时任务" },
      ]),
      "utf8",
    );
    expect((await cache.list()).map((row) => row.sessionId)).toEqual(["sess_c"]);

    await rm(file, { force: true });
    expect(await cache.list()).toEqual([]);
    // 重建同名文件内容不同 → 反映新内容（缓存没有陈旧复活）
    await writeFile(
      file,
      jsonl([
        { v: 1, type: "session_start", ts: Date.now(), sessionId: "sess_c", workspaceKey: "E:/other" },
        { v: 1, type: "user_message", ts: Date.now() + 1, sessionId: "sess_c", content: "重建后的任务" },
      ]),
      "utf8",
    );
    const rows = await cache.list();
    expect(rows[0]).toMatchObject({ workspaceKey: "E:/other", preview: "重建后的任务" });

    // 空文件与纯坏行文件：与原 listSessions 一致，不当会话列出
    await writeFile(join(dir, "sess_empty.jsonl"), "", "utf8");
    await writeFile(join(dir, "sess_bad.jsonl"), "not json\nnot json either\n", "utf8");
    const finalRows = await cache.list();
    expect(finalRows.map((row) => row.sessionId)).toEqual(["sess_c"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("无 session_start 的工作区回退 cwd；无 key 事件不猜归属", async () => {
    const { dir, cache } = await setup();
    await writeFile(
      join(dir, "sess_d.jsonl"),
      jsonl([
        { v: 1, type: "session_start", ts: Date.now(), sessionId: "sess_d", cwd: "C:/legacy" },
        { v: 1, type: "user_message", ts: Date.now() + 1, sessionId: "sess_d", content: "旧会话" },
      ]),
      "utf8",
    );
    const rows = await cache.list();
    expect(rows[0]?.workspaceKey).toBe("C:/legacy");
    await rm(dir, { recursive: true, force: true });
  });
});

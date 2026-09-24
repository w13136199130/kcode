import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionEvent } from "@kcode/contracts";
import { JsonlSessionSink } from "../src/index.js";
import { createSessionsTool, listSessions, loadSessionEvents, parseJsonlPrefix, rebuildHistory } from "../src/index.js";

let root: string;
let sessionsDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-resume-"));
  sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir, { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const ev = (e: SessionEvent): string => `${JSON.stringify(e)}\n`;

describe("rebuildHistory（事件流→历史，§5.3）", () => {
  it("工具轮次合并为带 toolCalls 的 assistant，其后接 tool 消息", () => {
    const history = rebuildHistory(
      [
        { v: 1, type: "user_message", ts: 0, sessionId: "s", content: "q" },
        { v: 1, type: "tool_call", ts: 0, sessionId: "s", callId: "c1", tool: "echo", args: { a: 1 } },
        { v: 1, type: "assistant_message", ts: 0, sessionId: "s", content: "查一下" },
        { v: 1, type: "tool_result", ts: 0, sessionId: "s", callId: "c1", ok: true, output: "hi" },
        { v: 1, type: "assistant_message", ts: 0, sessionId: "s", content: "结论" },
        { v: 1, type: "session_end", ts: 0, sessionId: "s", reason: "completed" },
      ].map((e) => JSON.parse(JSON.stringify(e)) as SessionEvent),
    );
    expect(history).toHaveLength(4);
    expect(history[0]).toMatchObject({ role: "user", content: "q" });
    expect(history[1]).toMatchObject({ role: "assistant", content: "查一下" });
    expect(history[1]?.toolCalls).toEqual([{ callId: "c1", tool: "echo", args: { a: 1 } }]);
    expect(history[2]).toMatchObject({ role: "tool", content: "hi", toolCallId: "c1", name: "echo" });
    expect(history[3]).toMatchObject({ role: "assistant", content: "结论" });
  });

  it("compaction_summary 还原为占位消息；todo/skill 元事件跳过", () => {
    const history = rebuildHistory([
      { v: 1, type: "user_message", ts: 0, sessionId: "s", content: "a" },
      { v: 1, type: "todo_update", ts: 0, sessionId: "s", todos: [] },
      { v: 1, type: "skill_used", ts: 0, sessionId: "s", skill: "x", trigger: "auto" },
      { v: 1, type: "compaction_summary", ts: 0, sessionId: "s", summary: "压缩摘要", dropped: 3 },
    ]);
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({ role: "assistant", content: "压缩摘要" });
  });

  it("compaction_summary 折叠头部：保留首用户锚点 + 摘要，已折叠内容不复活", () => {
    const history = rebuildHistory([
      { v: 1, type: "user_message", ts: 0, sessionId: "s", content: "第一问" },
      { v: 1, type: "assistant_message", ts: 0, sessionId: "s", content: "第一答" },
      { v: 1, type: "user_message", ts: 0, sessionId: "s", content: "第二问" },
      { v: 1, type: "assistant_message", ts: 0, sessionId: "s", content: "第二答" },
      { v: 1, type: "compaction_summary", ts: 0, sessionId: "s", summary: "压缩摘要", dropped: 2, covered: 2 },
      { v: 1, type: "user_message", ts: 0, sessionId: "s", content: "第三问" },
      { v: 1, type: "assistant_message", ts: 0, sessionId: "s", content: "第三答" },
    ]);
    const text = JSON.stringify(history);
    expect(text).toContain("第一问"); // 首用户锚点保留
    expect(text).toContain("压缩摘要"); // 摘要占位
    expect(text).not.toContain("第一答"); // 已折叠内容不复活
    expect(text).toContain("第二问"); // 尾部保留
    expect(text).toContain("第三问");
  });

  it("崩溃残留的无结果 tool_call 不进入历史（不重放未知写操作）", () => {
    const history = rebuildHistory([
      { v: 1, type: "user_message", ts: 0, sessionId: "s", content: "改个文件" },
      { v: 1, type: "tool_call", ts: 0, sessionId: "s", callId: "c1", tool: "write", args: { path: "a.txt", content: "x" } },
      { v: 1, type: "assistant_message", ts: 0, sessionId: "s", content: "我来改" },
    ]);
    const text = JSON.stringify(history);
    // 悬空的 write 调用被丢弃，只保留正文——结果未知的写操作不得被模型重放
    expect(text).not.toContain("write");
    expect(text).toContain("我来改");
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({ role: "assistant", content: "我来改" });
    expect(history[1]?.toolCalls).toBeUndefined();
  });
});

describe("listSessions / loadSessionEvents", () => {
  it("列出会话（最近优先），损坏文件跳过", async () => {
    const old = join(sessionsDir, "sess_old.jsonl");
    const recent = join(sessionsDir, "sess_recent.jsonl");
    await writeFile(old, ev({ v: 1, type: "session_start", ts: 0, sessionId: "sess_old", model: "m" }) + ev({ v: 1, type: "user_message", ts: 0, sessionId: "sess_old", content: "旧会话首问" }));
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(recent, ev({ v: 1, type: "user_message", ts: 0, sessionId: "sess_recent", content: "新会话首问" }) + ev({ v: 1, type: "user_message", ts: 0, sessionId: "sess_recent", content: "第二轮" }));
    await writeFile(join(sessionsDir, "broken.jsonl"), "{not json}\n");

    const summaries = await listSessions(sessionsDir);
    expect(summaries.map((s) => s.sessionId)).toEqual(["sess_recent", "sess_old"]);
    expect(summaries[0]?.turns).toBe(2);
    expect(summaries[0]?.preview).toBe("新会话首问");

    const events = await loadSessionEvents(recent);
    expect(events).toHaveLength(2);
  });

  it("parseJsonlPrefix 恢复有效前缀：尾部截断不整段失败", () => {
    const text =
      ev({ v: 1, type: "user_message", ts: 0, sessionId: "s", content: "第一问" }) +
      ev({ v: 1, type: "assistant_message", ts: 0, sessionId: "s", content: "第一答" }) +
      '{"v":1,"type":"user_message","ts":0,"sess'; // 截断的尾行
    const events = parseJsonlPrefix(text);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "assistant_message", content: "第一答" });
  });

  it("loadSessionEvents 对截断尾部返回有效前缀（崩溃会话仍可续接）", async () => {
    const filePath = join(sessionsDir, "sess_truncated.jsonl");
    await writeFile(
      filePath,
      ev({ v: 1, type: "user_message", ts: 0, sessionId: "s", content: "完整问" }) +
        '{"v":1,"type":"user_message","ts":0,"sessionId":"s","cont',
    );
    const events = await loadSessionEvents(filePath);
    expect(events).toHaveLength(1);
  });

  it("listSessions 按 (workspaceKey, mtime) 分组排序", async () => {
    const ws = await mkdtemp(join(tmpdir(), "kcode-ws-list-"));
    try {
      await writeFile(
        join(ws, "a1.jsonl"),
        ev({ v: 1, type: "session_start", ts: 0, sessionId: "a1", workspaceKey: "proj/a" }) +
          ev({ v: 1, type: "user_message", ts: 0, sessionId: "a1", content: "a1" }),
      );
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(
        join(ws, "a2.jsonl"),
        ev({ v: 1, type: "session_start", ts: 0, sessionId: "a2", workspaceKey: "proj/a" }) +
          ev({ v: 1, type: "user_message", ts: 0, sessionId: "a2", content: "a2" }),
      );
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(
        join(ws, "b1.jsonl"),
        ev({ v: 1, type: "session_start", ts: 0, sessionId: "b1", workspaceKey: "proj/b" }) +
          ev({ v: 1, type: "user_message", ts: 0, sessionId: "b1", content: "b1" }),
      );

      const summaries = await listSessions(ws);
      // 分组：proj/a 在前、proj/b 在后；组内 mtime 倒序（a2 比 a1 新）
      expect(summaries.map((s) => s.sessionId)).toEqual(["a2", "a1", "b1"]);
      expect(summaries[0]?.workspaceKey).toBe("proj/a");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe("sessions 工具（跨会话读取）", () => {
  it("list 与 read（浓缩转写）", async () => {
    const tool = createSessionsTool({ sessionsDir });
    const listed = await tool.execute({ action: "list" }, { sessionId: "s" });
    expect(listed.ok).toBe(true);
    expect(listed.output).toContain("sess_recent");

    const read = await tool.execute(
      { action: "read", sessionId: "sess_recent" },
      { sessionId: "s" },
    );
    expect(read.ok).toBe(true);
    expect(read.output).toContain("👤 新会话首问");

    const missing = await tool.execute({ action: "read", sessionId: "nope" }, { sessionId: "s" });
    expect(missing.ok).toBe(false);
  });
});

describe("与 JsonlSessionSink 往返", () => {
  it("写读往返一致", async () => {
    const filePath = join(sessionsDir, "sess_roundtrip.jsonl");
    const sink = await JsonlSessionSink.open(filePath);
    await sink.append({ v: 1, type: "user_message", ts: 1, sessionId: "sess_roundtrip", content: "往返" });
    const events = await loadSessionEvents(filePath);
    expect(rebuildHistory(events)[0]).toMatchObject({ role: "user", content: "往返" });
  });
});

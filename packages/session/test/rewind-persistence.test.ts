import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLLM } from "@kcode/core";
import type { SessionEvent } from "@kcode/contracts";
import {
  JsonlSessionSink,
  effectiveEvents,
  listSessions,
  loadSessionEvents,
  rebuildHistory,
} from "@kcode/runtime";
import { composeSession, resolveResumeHistory } from "../src/composition.js";

/**
 * M1-02 回归：/rewind 必须**可回放**。
 *
 * 缺陷（N0-1）：rewind 只调 loop.replaceHistory() 改内存，JSONL 不落任何记录；
 * 而 resolveResumeHistory 用 rebuildHistory(全部事件) 重建 ⇒ 重启后被回退的内容复活。
 *
 * 设计：回退写成 append-only 的 session_rewind 截断标记（含 keepEvents 下标），
 * 回放侧取最后一条标记的有效前缀。见 packages/contracts/src/session.ts 的 SessionRewindEvent。
 *
 * 场景编号对应 DESIGN.md §8.1 的 N0 回归清单。
 */

let root: string;
let sessionsDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-rewind-"));
  sessionsDir = join(root, "cli", "sessions");
  await mkdir(sessionsDir, { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const S = "sess_rewind_test";
const ts = 1_700_000_000_000;

/** 造一段「两轮提问」的事件流，返回事件与其下标关键点 */
function twoTurnEvents() {
  const events: SessionEvent[] = [
    { v: 1, type: "session_start", ts, sessionId: S, model: "scripted/simple" },
    { v: 1, type: "user_message", ts, sessionId: S, content: "第一问" },
    { v: 1, type: "assistant_message", ts, sessionId: S, content: "第一答" },
    { v: 1, type: "session_end", ts, sessionId: S, reason: "completed" },
    { v: 1, type: "user_message", ts, sessionId: S, content: "第二问" },
    { v: 1, type: "assistant_message", ts, sessionId: S, content: "第二答" },
    { v: 1, type: "session_end", ts, sessionId: S, reason: "completed" },
  ];
  // 回退到「第二问」之前 ⇒ 保留前 4 个事件
  const keepEvents = 4;
  return { events, keepEvents, secondQuestionIndex: 4 };
}

/** 把事件写成真实会话文件（走 JsonlSessionSink，与生产同一条落盘路径） */
async function writeSession(sessionId: string, events: SessionEvent[]): Promise<string> {
  const file = join(sessionsDir, `${sessionId}.jsonl`);
  const sink = await JsonlSessionSink.open(file);
  for (const event of events) {
    await sink.append(event);
  }
  return file;
}

describe("M1-02 /rewind 可回放（场景 3：回退后立即重启）", () => {
  it("rebuildHistory 只重建最后一条 session_rewind 的 keepEvents 前缀", () => {
    const { events, keepEvents } = twoTurnEvents();
    const stream: SessionEvent[] = [
      ...events,
      { v: 1, type: "session_rewind", ts, sessionId: S, keepEvents, restoredFiles: 1 },
    ];

    const history = rebuildHistory(stream);
    const text = JSON.stringify(history);

    expect(text).toContain("第一问");
    expect(text).toContain("第一答");
    // 被回退的部分不得复活
    expect(text).not.toContain("第二问");
    expect(text).not.toContain("第二答");
  });

  it("重启后 resolveResumeHistory 不复活已回退内容（走真实 JSONL 落盘）", async () => {
    const { events, keepEvents } = twoTurnEvents();
    const sessionId = "sess_rewind_resume";
    const stream: SessionEvent[] = [
      ...events,
      { v: 1, type: "session_rewind", ts, sessionId, keepEvents, restoredFiles: 1 },
    ];
    await writeSession(sessionId, stream);

    const resumed = await resolveResumeHistory(root, sessionId);
    expect(resumed).not.toBeNull();
    const text = JSON.stringify(resumed!.messages);

    expect(text).toContain("第一问");
    expect(text).not.toContain("第二问");
    expect(text).not.toContain("第二答");
  });

  it("连续回退两次：以最后一条标记为准", () => {
    const { events, keepEvents } = twoTurnEvents();
    const stream: SessionEvent[] = [
      ...events,
      { v: 1, type: "session_rewind", ts, sessionId: S, keepEvents }, // 回到第二问之前（保留 4）
      // 再退到第一问之前 ⇒ 保留 index 0（session_start），第一问在 index 1
      { v: 1, type: "session_rewind", ts, sessionId: S, keepEvents: 1 },
    ];

    const history = rebuildHistory(stream);
    const text = JSON.stringify(history);

    expect(text).not.toContain("第一问");
    expect(text).not.toContain("第二问");
    expect(text).not.toContain("第一答");
  });

  it("回退标记本身不进入历史（不是对话消息）", () => {
    const { events, keepEvents } = twoTurnEvents();
    const stream: SessionEvent[] = [
      ...events,
      { v: 1, type: "session_rewind", ts, sessionId: S, keepEvents },
    ];

    const history = rebuildHistory(stream);
    // 回退标记若被当成 assistant 消息塞进历史，会在续接时污染上下文
    expect(history.some((m) => m.content.includes("keepEvents"))).toBe(false);
    for (const message of history) {
      expect(message.content).not.toContain("session_rewind");
    }
  });

  it("回退点清单只列有效前缀内的提问", async () => {
    const { events, keepEvents } = twoTurnEvents();
    const sessionId = "sess_rewind_points";
    const stream: SessionEvent[] = [
      ...events,
      { v: 1, type: "session_rewind", ts, sessionId, keepEvents },
    ];
    const file = await writeSession(sessionId, stream);
    const loaded = await loadSessionEvents(file);

    // 生产侧 listRewindPoints 只遍历有效前缀；此处断言同源的裁剪语义
    const effective = effectiveEvents(loaded);
    const prompts = effective.filter((e) => e.type === "user_message").map((e) => e.content);

    expect(prompts).toEqual(["第一问"]);
  });
});

/**
 * 期望的实现契约：回放侧统一经此得到「有效事件前缀」。
 * 已由 @kcode/runtime 的 effectiveEvents 提供，生产代码（composition/rebuildHistory）同源调用。
 */
describe("M1-02 /rewind 落盘（场景 2：回退后立即关闭）", () => {
  it("用量只累计有效前缀：已回退轮次的 session_end 不再计入", async () => {
    const sessionId = "sess_rewind_usage";
    const stream: SessionEvent[] = [
      { v: 1, type: "session_start", ts, sessionId, model: "m" },
      { v: 1, type: "user_message", ts, sessionId, content: "第一问" },
      { v: 1, type: "session_end", ts, sessionId, reason: "completed", usage: { inputTokens: 100, outputTokens: 10, calls: 1 } },
      { v: 1, type: "user_message", ts, sessionId, content: "第二问" },
      { v: 1, type: "session_end", ts, sessionId, reason: "completed", usage: { inputTokens: 999, outputTokens: 99, calls: 1 } },
      // 回退到第二问之前 ⇒ 只有第一轮的用量应保留
      { v: 1, type: "session_rewind", ts, sessionId, keepEvents: 3 },
    ];
    await writeSession(sessionId, stream);

    const resumed = await resolveResumeHistory(root, sessionId);
    expect(resumed).not.toBeNull();
    expect(resumed!.usage).toEqual({ inputTokens: 100, outputTokens: 10, calls: 1 });
  });

  it("会话文件里存在 session_rewind 记录，且 listSessions 仍能列出该会话", async () => {
    const { events, keepEvents } = twoTurnEvents();
    const sessionId = "sess_rewind_persist";
    const stream: SessionEvent[] = [
      ...events,
      { v: 1, type: "session_rewind", ts, sessionId, keepEvents, restoredFiles: 2 },
    ];
    const file = await writeSession(sessionId, stream);

    const loaded = await loadSessionEvents(file);
    const markers = loaded.filter((e) => e.type === "session_rewind");

    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ keepEvents, restoredFiles: 2 });

    // 会话索引（listSessions）不受影响，仍能按 mtime 列出
    const summaries = await listSessions(sessionsDir);
    expect(summaries.map((s) => s.sessionId)).toContain(sessionId);
  });
});

describe("M1-02 端到端：真实 composeSession 回退 → 重启续接", () => {
  it("回退后重启，被回退的轮次不进入续接历史", async () => {
    const e2eHome = await mkdtemp(join(tmpdir(), "kcode-rewind-e2e-"));
    const e2eWorkspace = await mkdtemp(join(tmpdir(), "kcode-rewind-e2e-ws-"));
    try {
      // 两轮对话：脚本化 LLM 每轮直接给答案（不调工具）
      const first = new ScriptedLLM([{ text: "第一答" }, { text: "第二答" }]);
      const session = await composeSession({
        llmFactory: async () => first,
        model: "scripted/simple",
        cwd: e2eWorkspace,
        kcodeHomeDir: e2eHome,
        asker: { confirm: async () => ({ allowed: true, scope: "once" }) },
      });

      await session.loop.run("第一问");
      await session.loop.run("第二问");

      // 回退到「第二问」之前
      const points = await session.listRewindPoints();
      expect(points.map((p) => p.preview)).toEqual(["第一问", "第二问"]);
      const second = points[1]!;
      const result = await session.rewind(second.eventIndex);
      expect(result.droppedEvents).toBeGreaterThan(0);

      // 回退必须已落盘
      const onDisk = await loadSessionEvents(session.jsonlPath);
      expect(onDisk.filter((e) => e.type === "session_rewind")).toHaveLength(1);

      // 回退点清单立刻收敛：第二问不再可选
      expect((await session.listRewindPoints()).map((p) => p.preview)).toEqual(["第一问"]);

      // 「重启」：按会话 id 走真实 resume 路径
      const sessionId = basename(session.jsonlPath, ".jsonl");
      const resumed = await resolveResumeHistory(e2eHome, sessionId);
      expect(resumed).not.toBeNull();
      const text = JSON.stringify(resumed!.messages);
      expect(text).toContain("第一问");
      expect(text).not.toContain("第二问");
      expect(text).not.toContain("第二答");
    } finally {
      await rm(e2eHome, { recursive: true, force: true });
      await rm(e2eWorkspace, { recursive: true, force: true });
    }
  }, 30_000);
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonlSessionSink } from "@kcode/runtime";
import { workspaceKey } from "@kcode/shared";
import { resolveResumeHistory } from "../src/composition.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-ws-resume-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeSession(sessionId: string, wsKey: string, preview: string): Promise<void> {
  const sink = await JsonlSessionSink.open(join(root, "cli", "sessions", `${sessionId}.jsonl`));
  await sink.append({ v: 1, type: "session_start", ts: 1, sessionId, workspaceKey: wsKey });
  await sink.append({ v: 1, type: "user_message", ts: 1, sessionId, content: preview });
  await sink.append({ v: 1, type: "assistant_message", ts: 1, sessionId, content: "答" });
  await sink.append({ v: 1, type: "session_end", ts: 1, sessionId, reason: "completed" });
}

describe("resolveResumeHistory 的工作区作用域", () => {
  it("latest 只取当前工作区内最近会话", async () => {
    await writeSession("sess_a_old", "proj/a", "A 旧");
    await new Promise((r) => setTimeout(r, 20));
    await writeSession("sess_b_new", "proj/b", "B 新");

    // 指定工作区 proj/b：取 proj/b 内最近 = b_new，不跨区取 a_old
    const scoped = await resolveResumeHistory(root, "latest", "proj/b");
    expect(scoped).not.toBeNull();
    expect(JSON.stringify(scoped!.messages)).toContain("B 新");
    expect(JSON.stringify(scoped!.messages)).not.toContain("A 旧");

    // 指定工作区 proj/a：取 proj/a 内最近 = a_old
    const scopedA = await resolveResumeHistory(root, "latest", "proj/a");
    expect(scopedA).not.toBeNull();
    expect(JSON.stringify(scopedA!.messages)).toContain("A 旧");
  });
});

describe("workspaceKey 归一化", () => {
  it("分隔符与尾斜杠归一为同一身份", () => {
    expect(workspaceKey("E:\\space\\proj")).toBe("E:/space/proj");
    expect(workspaceKey("E:/space/proj/")).toBe("E:/space/proj");
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonlSessionSink } from "@kcode/runtime";
import type { AgentLoop } from "@kcode/core";
import { CheckpointStore } from "../src/checkpoints.js";
import { rewindTo } from "../src/rewind.js";

let root: string;
let sessionsDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-rewind-child-"));
  sessionsDir = join(root, "cli", "sessions");
  await mkdir(join(sessionsDir, "subagents"), { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("3-05 rewind 覆盖子代理写操作", () => {
  it("父事件只有 subagent_spawned 时，仍按子会话 callId 恢复文件", async () => {
    const parentId = "sess_parent";
    const childId = "sub_child";
    const target = join(root, "child-edit.txt");
    await writeFile(target, "父会话基线", "utf8");

    const store = await CheckpointStore.open(join(root, "checkpoints", "parent"));
    await store.snapshot("child_call", target);
    await writeFile(target, "子代理改坏的内容", "utf8");

    const parentSink = await JsonlSessionSink.open(join(sessionsDir, `${parentId}.jsonl`));
    const ts = 1;
    await parentSink.append({ v: 1, type: "session_start", ts, sessionId: parentId, model: "m" });
    await parentSink.append({ v: 1, type: "user_message", ts, sessionId: parentId, content: "改文件" });
    await parentSink.append({
      v: 1,
      type: "subagent_spawned",
      ts,
      sessionId: parentId,
      agentId: "a1",
      agentType: "general-purpose",
      description: "子任务",
      childSessionId: childId,
      background: false,
    });
    await parentSink.append({ v: 1, type: "assistant_message", ts, sessionId: parentId, content: "完成" });

    const childSink = await JsonlSessionSink.open(join(sessionsDir, "subagents", `${childId}.jsonl`));
    await childSink.append({ v: 1, type: "session_start", ts, sessionId: childId, model: "m" });
    await childSink.append({
      v: 1,
      type: "tool_call",
      ts,
      sessionId: childId,
      callId: "child_call",
      tool: "write",
      args: { path: target, content: "子代理改坏的内容" },
    });

    const result = await rewindTo({
      eventIndex: 1,
      jsonlPath: join(sessionsDir, `${parentId}.jsonl`),
      sessionId: parentId,
      busy: false,
      checkpoints: store,
      sink: { append: async () => undefined },
      loop: { replaceHistory: () => undefined } as unknown as AgentLoop,
    });
    expect(result.restoredFiles).toBe(1);
    expect(await readFile(target, "utf8")).toBe("父会话基线");
  });
});

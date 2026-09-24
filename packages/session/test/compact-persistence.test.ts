import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLLM } from "@kcode/core";
import { loadSessionEvents } from "@kcode/runtime";
import { composeSession, resolveResumeHistory } from "../src/composition.js";

let home: string;
let workspace: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-compact-"));
  workspace = await mkdtemp(join(tmpdir(), "kcode-compact-ws-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

describe("手动 /compact 落盘", () => {
  it("compactNow 经 sink 写盘：重启后摘要可回放，已折叠内容不复活", async () => {
    // 父会话与摘要器共用同一个 LLM 实例：6 个文本轮 + 第 7 条脚本供摘要器消费
    const llm = new ScriptedLLM([
      { text: "答1" },
      { text: "答2" },
      { text: "答3" },
      { text: "答4" },
      { text: "答5" },
      { text: "答6" },
      { text: "【摘要】早期对话已折叠。" },
    ]);
    const session = await composeSession({
      llmFactory: async () => llm,
      model: "scripted/simple",
      cwd: workspace,
      kcodeHomeDir: home,
      asker: { confirm: async () => ({ allowed: true, scope: "once" }) },
    });

    for (const q of ["问1", "问2", "问3", "问4", "问5", "问6"]) {
      await session.loop.run(q);
    }

    const result = await session.compactNow();
    expect(result).not.toBeNull();
    expect(result!.dropped).toBeGreaterThan(0);

    // 手动压缩必须已落盘（此前只走 onEvent，重启即丢）
    const onDisk = await loadSessionEvents(session.jsonlPath);
    const markers = onDisk.filter((e) => e.type === "compaction_summary");
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ summary: "【摘要】早期对话已折叠。" });

    // 「重启」：按会话 id 走真实 resume 路径，摘要可见、被折叠的早期回答不复活
    const sessionId = basename(session.jsonlPath, ".jsonl");
    const resumed = await resolveResumeHistory(home, sessionId);
    expect(resumed).not.toBeNull();
    const text = JSON.stringify(resumed!.messages);
    expect(text).toContain("【摘要】早期对话已折叠。");
    expect(text).not.toContain("答1");
    expect(text).toContain("问6");

    await session.close();
  }, 30_000);
});

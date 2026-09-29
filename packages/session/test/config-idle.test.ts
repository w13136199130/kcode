import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLLM } from "@kcode/core";
import type { SessionEvent } from "@kcode/contracts";
import { composeSession } from "../src/composition.js";

/** N3E-6：空闲超阈值后下一次输入先压缩（idleCompactMs 注入缩短阈值）。 */
let home: string;
let ws: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-idle-home-"));
  ws = await mkdtemp(join(tmpdir(), "kcode-idle-ws-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(ws, { recursive: true, force: true });
});

describe("N3E-6 空闲压缩", () => {
  it("空闲超阈值：下一次输入先压缩（compaction_summary 落盘）；未超阈值不压", async () => {
    // 6 个文本轮供摘要折叠 + 摘要轮 +（空闲后）最后一轮
    const turns = ["问1", "问2", "问3", "问4", "问5", "问6"].map((q) => ({ text: `答${q}` }));
    const llm = new ScriptedLLM([...turns, { text: "【摘要】已折叠。" }, { text: "末轮" }]);
    const events: SessionEvent[] = [];
    const session = await composeSession({
      llmFactory: async () => llm,
      model: "scripted/simple",
      cwd: ws,
      kcodeHomeDir: home,
      onEvent: (e) => events.push(e),
      idleCompactMs: 80, // 测试注入：80ms 即视为空闲
    });
    for (const q of ["问1", "问2", "问3", "问4", "问5", "问6"]) {
      await session.loop.run(q);
    }
    expect(events.some((e) => e.type === "compaction_summary")).toBe(false); // 空闲前不压
    await new Promise((r) => setTimeout(r, 250)); // 越过空闲阈值
    await session.loop.run("最后一问");
    expect(events.some((e) => e.type === "compaction_summary" && e.summary.includes("已折叠"))).toBe(true);
    await session.close();
  }, 30_000);
});

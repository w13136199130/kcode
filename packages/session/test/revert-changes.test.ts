import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ScriptedLLM } from "@kcode/core";
import type { LLMProvider } from "@kcode/contracts";
import { composeSession } from "../src/composition.js";

/**
 * 3-23 会话级契约：`listChanges` 给出检查点基线 → 当前磁盘的 diff，
 * `revertChanges` 逐文件/全量恢复前像；运行中拒绝（避免与写工具竞态）。
 */

let home: string;
let workspace: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-revert-home-"));
  workspace = await mkdtemp(join(tmpdir(), "kcode-revert-ws-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

async function openSession(llm: LLMProvider, cwd = workspace) {
  return composeSession({
    llmFactory: async () => llm,
    model: "scripted/simple",
    cwd,
    kcodeHomeDir: home,
    initialMode: "acceptEdits",
  });
}

function writeScript(file: string, content: string): ScriptedLLM {
  return new ScriptedLLM([
    // 3-09 读后校验：已存在文件必须先 read 再 write
    { toolCalls: [{ callId: `r-${file}`, tool: "read", args: { path: file } }] },
    { toolCalls: [{ callId: `w-${file}`, tool: "write", args: { path: file, content } }] },
    { text: "完成" },
  ]);
}

describe("/diff 会话级 listChanges / revertChanges", () => {
  it("改写已有文件：diff 以首个检查点为基线，逐文件回退恢复原文", async () => {
    const file = join(workspace, "edit-me.txt");
    await writeFile(file, "old\n", "utf8");
    const session = await openSession(writeScript("edit-me.txt", "new\n"));
    await session.loop.run("改文件");

    const changes = await session.listChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: file, existed: true });
    expect(changes[0]!.diff).toContain("-old");
    expect(changes[0]!.diff).toContain("+new");

    const result = await session.revertChanges([file]);
    expect(result.restoredFiles).toBeGreaterThan(0);
    expect(await readFile(file, "utf8")).toBe("old\n");
    expect(await session.listChanges()).toEqual([]);
    await session.close();
  }, 30_000);

  it("新建文件回退 = 删除；全量回退覆盖多个文件", async () => {
    const edited = join(workspace, "multi-a.txt");
    await writeFile(edited, "a0\n", "utf8");
    const session = await openSession(
      new ScriptedLLM([
        { toolCalls: [{ callId: "r1", tool: "read", args: { path: "multi-a.txt" } }] },
        {
          toolCalls: [
            { callId: "m1", tool: "write", args: { path: "multi-a.txt", content: "a1\n" } },
            { callId: "m2", tool: "write", args: { path: "multi-b.txt", content: "b1\n" } },
          ],
        },
        { text: "完成" },
      ]),
    );
    await session.loop.run("多文件");

    const changes = await session.listChanges();
    expect(changes.map((c) => c.path).sort()).toEqual([join(workspace, "multi-b.txt"), edited].sort());
    expect(changes.find((c) => c.path === join(workspace, "multi-b.txt"))?.existed).toBe(false);

    const result = await session.revertChanges();
    expect(result.restoredFiles).toBeGreaterThanOrEqual(2);
    expect(await readFile(edited, "utf8")).toBe("a0\n");
    expect(existsSync(join(workspace, "multi-b.txt"))).toBe(false);
    expect(await session.listChanges()).toEqual([]);
    await session.close();
  }, 30_000);

  it("运行中拒绝回退（与写工具互斥）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated: LLMProvider = {
      id: "gated",
      async *stream() {
        await gate;
        yield { type: "end", reason: "stop" };
      },
    };
    const session = await openSession(gated);
    const running = session.loop.run("等着");
    await vi.waitFor(() => expect(session.runner.busy).toBe(true));
    await expect(session.revertChanges()).rejects.toThrow("运行中不能回退文件");
    release();
    await running;
    await session.close();
  }, 30_000);
});

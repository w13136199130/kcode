import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLLM } from "@kcode/core";
import { composeSession } from "../src/composition.js";

let home: string;
let workspace: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-session-opts-"));
  workspace = await mkdtemp(join(tmpdir(), "kcode-session-opts-ws-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

/** 单轮"模型点名 write 工具"的脚本：第 2 轮收尾，验证 write 是否真的执行 */
function writeScript(filename: string): ScriptedLLM {
  return new ScriptedLLM([
    { toolCalls: [{ callId: "w1", tool: "write", args: { path: filename, content: "x" } }] },
    { text: "完成" },
  ]);
}

describe("--mode 初始档（initialMode）", () => {
  it("plan：write 非只读被拒，文件不落盘（与运行中 /mode plan 同一语义）", async () => {
    const llm = writeScript("plan-out.txt");
    const session = await composeSession({
      llmFactory: async () => llm,
      model: "scripted/simple",
      cwd: workspace,
      kcodeHomeDir: home,
      initialMode: "plan",
    });
    await session.loop.run("写一个文件");
    expect(existsSync(join(workspace, "plan-out.txt"))).toBe(false);
    await session.close();
  }, 30_000);

  it("acceptEdits：write 免确认直接执行", async () => {
    const llm = writeScript("accept-out.txt");
    const session = await composeSession({
      llmFactory: async () => llm,
      model: "scripted/simple",
      cwd: workspace,
      kcodeHomeDir: home,
      initialMode: "acceptEdits",
    });
    await session.loop.run("写一个文件");
    expect(existsSync(join(workspace, "accept-out.txt"))).toBe(true);
    await session.close();
  }, 30_000);
});

describe("--disallowed-tools（disallowedTools）", () => {
  it("未知工具名 fail-fast：组装期抛错并列出可用工具", async () => {
    await expect(
      composeSession({
        llmFactory: async () => new ScriptedLLM([{ text: "x" }]),
        model: "scripted/simple",
        cwd: workspace,
        kcodeHomeDir: home,
        disallowedTools: ["no-such-tool"],
      }),
    ).rejects.toThrow("未知工具");
  });

  it("write 被剔除：模型点名 write 也不会执行（文件不落盘，轮次正常收尾）", async () => {
    const llm = writeScript("disallowed-out.txt");
    const session = await composeSession({
      llmFactory: async () => llm,
      model: "scripted/simple",
      cwd: workspace,
      kcodeHomeDir: home,
      disallowedTools: ["write", "edit"],
    });
    const summary = await session.loop.run("写一个文件");
    expect(summary.status).toBe("completed");
    expect(existsSync(join(workspace, "disallowed-out.txt"))).toBe(false);
    await session.close();
  }, 30_000);

  it("逗号/空白混排输入可归一化", async () => {
    const session = await composeSession({
      llmFactory: async () => new ScriptedLLM([{ text: "x" }]),
      model: "scripted/simple",
      cwd: workspace,
      kcodeHomeDir: home,
      disallowedTools: ["write, edit", "task"],
    });
    // 不抛"未知工具"即证明归一化后三个名字都在全集内
    await session.close();
  });
});

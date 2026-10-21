import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLLM } from "@kcode/core";
import type { SessionEvent } from "@kcode/contracts";
import { composeSession } from "../src/composition.js";

/** 4-02：策略文件从组装层进入主权限引擎（deny 在未信任项目也生效） */
let home: string;
let workspace: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-policy-home-"));
  workspace = await mkdtemp(join(tmpdir(), "kcode-policy-ws-"));
  await mkdir(join(workspace, ".kcode"), { recursive: true });
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

describe("项目策略文件接线", () => {
  it("deny bash 命令：模型调用直接 permission denied，不执行", async () => {
    await writeFile(
      join(workspace, ".kcode", "policy.json"),
      JSON.stringify({
        version: 1,
        rules: [
          {
            tool: "bash",
            commandPrefix: ["echo policy-should-block", "rm -rf /"],
            decision: "deny",
            priority: 100,
            reason: "测试策略",
          },
        ],
      }),
      "utf8",
    );
    const events: SessionEvent[] = [];
    const llm = new ScriptedLLM([
      { toolCalls: [{ callId: "b1", tool: "bash", args: { command: "echo policy-should-block" } }] },
      { text: "完成" },
    ]);
    const session = await composeSession({
      llmFactory: async () => llm,
      model: "m",
      cwd: workspace,
      kcodeHomeDir: home,
      ephemeral: true,
      onEvent: (event) => events.push(event),
    });
    await session.loop.run("执行测试命令");
    // `!命令` 显式直执行也不能绕过策略 deny
    const direct = await session.runBash("echo policy-should-block");
    expect(direct.ok).toBe(false);
    expect(direct.error).toContain("policy deny");
    await session.close();

    const result = events.find((event) => event.type === "tool_result" && event.callId === "b1");
    expect(result).toBeDefined();
    if (result?.type === "tool_result") {
      expect(result.ok).toBe(false);
      expect(result.error).toContain("permission denied");
      expect(result.output).not.toContain("policy-should-block");
    }
  }, 30_000);
});

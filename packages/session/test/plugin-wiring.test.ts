import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLLM } from "@kcode/core";
import type { SessionEvent } from "@kcode/contracts";
import { installPlugin } from "@kcode/extensions";
import { composeSession } from "../src/composition.js";

/**
 * 3-16 插件接线（会话级集成）：
 * - manifest.hooks 进入同一 runner，cwd 指向插件安装目录（脚本相对路径可用）；
 * - manifest.permissions 收紧既有权限引擎（read:deny 立即生效）；
 * - 只装载最新版本（安装期清理 + 加载兜底）。
 */

let home: string;
let workspace: string;
const cleanups: string[] = [];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-plugin-wire-"));
  workspace = await mkdtemp(join(tmpdir(), "kcode-plugin-wire-ws-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true });
});

async function installDemoPlugin(version = "1.0.0"): Promise<string> {
  const src = await mkdtemp(join(tmpdir(), `kcode-plugin-src-${version}-`));
  cleanups.push(src);
  await writeFile(
    join(src, ".kcode-plugin"),
    JSON.stringify({
      schema: "kcode.plugin/1",
      name: "wire-demo",
      version,
      hooks: [{ event: "stop", command: "node hook.mjs" }],
      skills: [],
      commands: [],
      agents: ["helper"],
      mcp: [],
      permissions: ["read:deny"],
    }),
    "utf8",
  );
  await mkdir(join(src, "agents"), { recursive: true });
  await writeFile(
    join(src, "agents", "helper.md"),
    "---\ndescription: 插件子代理\npermissionMode: plan\n---\n你是插件提供的只读助手。",
    "utf8",
  );
  // 相对 cwd 写标记：只有 runner 把 cwd 设成插件安装目录时才会落在其上一级
  await writeFile(
    join(src, "hook.mjs"),
    'import { writeFileSync } from "node:fs";\nwriteFileSync("../ran.txt", "x");\n',
    "utf8",
  );
  await installPlugin(src, join(home, "cli", "plugins", "cache"));
  return join(home, "cli", "plugins", "cache", "wire-demo", version);
}

describe("插件 hooks / permissions 进入会话", () => {
  it("插件 hook 以安装目录为 cwd 执行；read:deny 生效", async () => {
    const installPath = await installDemoPlugin();
    await writeFile(join(workspace, "a.txt"), "内容", "utf8");
    const events: SessionEvent[] = [];
    const llm = new ScriptedLLM([
      { toolCalls: [{ callId: "r1", tool: "read", args: { path: "a.txt" } }] },
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
    await session.loop.run("读一下 a.txt");
    await session.close();

    // 插件权限规则进入主权限引擎：read 被 deny（不是 ask，无需交互）
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(toolResult.ok).toBe(false);
      expect(toolResult.error).toContain("permission denied");
    }

    // stop hook 在插件安装目录执行（相对路径 ../ran.txt 落在其上一级，避免污染 seed）
    expect(existsSync(join(installPath, "..", "ran.txt"))).toBe(true);
  }, 30_000);

  it("hooksInfo 标注 plugin 来源与插件名", async () => {
    const session = await composeSession({
      llmFactory: async () => new ScriptedLLM([{ text: "x" }]),
      model: "m",
      cwd: workspace,
      kcodeHomeDir: home,
      ephemeral: true,
    });
    const pluginHooks = session.hooksInfo().filter((h) => h.source === "plugin");
    expect(pluginHooks.some((h) => h.plugin === "wire-demo" && h.event === "stop")).toBe(true);
    await session.close();
  }, 30_000);

  it("插件 agents/ 进入 task 子代理类型（source=plugin）", async () => {
    const events: SessionEvent[] = [];
    const llms: ScriptedLLM[] = [];
    const session = await composeSession({
      llmFactory: async () => {
        const llm = new ScriptedLLM(
          llms.length === 0
            ? [
                {
                  toolCalls: [
                    {
                      callId: "p1",
                      tool: "task",
                      args: { subagent_type: "helper", description: "插件助手", prompt: "给出结论" },
                    },
                  ],
                },
                { text: "完成" },
              ]
            : [{ text: "插件子代理结论" }],
        );
        llms.push(llm);
        return llm;
      },
      model: "m",
      cwd: workspace,
      kcodeHomeDir: home,
      ephemeral: true,
      onEvent: (e) => events.push(e),
    });
    await session.loop.run("调用插件子代理");
    const result = events.find((e) => e.type === "tool_result" && e.callId === "p1");
    expect(result?.type === "tool_result" && result.ok).toBe(true);
    expect(result?.type === "tool_result" && result.output).toContain("插件子代理结论");
    await session.close();
  }, 30_000);
});

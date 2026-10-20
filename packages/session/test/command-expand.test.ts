import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLLM } from "@kcode/core";
import { composeSession } from "../src/composition.js";

/**
 * 3-17 命令 frontmatter / 命名空间 / !bash 的会话级接线：
 * 用户命令目录 → listCommands 带元数据 → expandCommand 执行 `!` 行并剥掉 frontmatter。
 */

let home: string;
let workspace: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-cmd-expand-"));
  workspace = await mkdtemp(join(tmpdir(), "kcode-cmd-expand-ws-"));
  await mkdir(join(home, "commands", "team"), { recursive: true });
  await writeFile(
    join(home, "commands", "status.md"),
    ["---", "description: 看仓库状态", 'argument-hint: "[路径]"', "---", "!`echo hi`", "结束"].join("\n"),
    "utf8",
  );
  await writeFile(join(home, "commands", "team", "deploy.md"), "部署 $ARGUMENTS", "utf8");
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

describe("命令 frontmatter / 命名空间 / !bash（会话级）", () => {
  it("listCommands 带 frontmatter；命名空间可展开；!行执行后回填", async () => {
    const session = await composeSession({
      llmFactory: async () => new ScriptedLLM([{ text: "x" }]),
      model: "m",
      cwd: workspace,
      kcodeHomeDir: home,
      ephemeral: true,
    });
    const status = session.listCommands().find((c) => c.name === "status");
    expect(status).toMatchObject({ description: "看仓库状态", argumentHint: "[路径]" });
    expect(session.listCommands().some((c) => c.name === "team:deploy")).toBe(true);

    expect(await session.expandCommand("team:deploy", "prod")).toBe("部署 prod");
    const expanded = await session.expandCommand("status", "");
    expect(expanded).not.toContain("---");
    expect(expanded).toContain('<bash_command command="echo hi">');
    expect(expanded).toContain("hi");
    expect(expanded).toContain("结束");
    await session.close();
  }, 30_000);
});

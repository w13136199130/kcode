import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commandsListCommand, skillsListCommand } from "../src/inspect.js";

let cwd: string;
let home: string;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "kcode-inspect-"));
  home = await mkdtemp(join(tmpdir(), "kcode-inspect-home-"));
  await mkdir(join(cwd, ".kcode", "skills", "deploy"), { recursive: true });
  await mkdir(join(cwd, ".kcode", "commands"), { recursive: true });
  await writeFile(
    join(cwd, ".kcode", "skills", "deploy", "SKILL.md"),
    "---\nname: deploy\ndescription: 部署指南技能\n---\n正文",
    "utf8",
  );
  await writeFile(join(cwd, ".kcode", "commands", "build.md"), "构建模板 $ARGUMENTS", "utf8");
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("kcode skills/commands list（N3C-3）", () => {
  it("盘点项目级技能并标注来源", async () => {
    const lines: string[] = [];
    await skillsListCommand(cwd, home, (l) => lines.push(l));
    expect(lines).toEqual(["deploy — 部署指南技能（项目）"]);
  });

  it("盘点项目级命令", async () => {
    const lines: string[] = [];
    await commandsListCommand(cwd, home, (l) => lines.push(l));
    expect(lines).toEqual(["/build（项目）"]);
  });

  it("空环境给出可行动的提示而非空白", async () => {
    const empty = await mkdtemp(join(tmpdir(), "kcode-inspect-empty-"));
    try {
      const skillLines: string[] = [];
      await skillsListCommand(empty, home, (l) => skillLines.push(l));
      expect(skillLines[0]).toMatch(/未发现技能/);
      const cmdLines: string[] = [];
      await commandsListCommand(empty, home, (l) => cmdLines.push(l));
      expect(cmdLines[0]).toMatch(/未发现自定义命令/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

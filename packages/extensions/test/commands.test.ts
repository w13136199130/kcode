import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CommandLibrary,
  discoverCommands,
  expandCommand,
  expandCommandTemplate,
  parseCommandFile,
} from "../src/index.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-cmds-"));
  const userDir = join(root, "user-commands");
  const projectDir = join(root, "project", ".kcode", "commands");
  await mkdir(userDir, { recursive: true });
  await mkdir(join(projectDir, "git"), { recursive: true });
  await mkdir(join(projectDir, "ops", "deploy"), { recursive: true });
  await writeFile(join(userDir, "review.md"), "请审查以下内容：$ARGUMENTS", "utf8");
  await writeFile(join(userDir, "shared.md"), "用户级版本", "utf8");
  await writeFile(join(projectDir, "shared.md"), "项目级版本（覆盖同名）", "utf8");
  await writeFile(join(projectDir, "Bad Name.md"), "不合规文件名", "utf8");
  await writeFile(join(projectDir, "notes.txt"), "非 md 忽略", "utf8");
  await writeFile(
    join(projectDir, "git", "commit.md"),
    [
      "---",
      "description: 提交改动",
      'argument-hint: "<message>"',
      "allowed-tools:",
      "  - read",
      "  - bash",
      "model: glm/glm-5",
      "---",
      "提交：$ARGUMENTS",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(projectDir, "ops", "deploy", "prod.md"), "部署生产", "utf8");
  await writeFile(
    join(userDir, "withbash.md"),
    ["---", "description: 看状态", "---", "先看状态：", "!`git status --short`", "结束"].join("\n"),
    "utf8",
  );
  await writeFile(join(userDir, "broken.md"), "---\ndescription: 缺结尾\n正文仍在", "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("斜杠命令发现与展开", () => {
  it("项目级覆盖用户级同名命令；不合规文件名告警跳过", async () => {
    const warns: string[] = [];
    const commands = await discoverCommands(
      [
        { dir: join(root, "project", ".kcode", "commands"), source: "project" },
        { dir: join(root, "user-commands"), source: "user" },
      ],
      (m) => warns.push(m),
    );
    const names = commands.map((c) => `${c.name}@${c.source}`);
    expect(names).toContain("review@user");
    expect(names).toContain("shared@project");
    expect(names).not.toContain("shared@user");
    expect(warns.some((w) => w.includes("不合规"))).toBe(true);
  });

  it("$ARGUMENTS 占位替换；无占位符时参数追加", () => {
    expect(expandCommand("审查：$ARGUMENTS", "src/a.ts")).toBe("审查：src/a.ts");
    expect(expandCommand("固定模板", "额外说明")).toBe("固定模板\n\n额外说明");
    expect(expandCommand("固定模板", "")).toBe("固定模板");
  });

  it("命令库按名展开；不存在返回 null", async () => {
    const library = await CommandLibrary.open([
      { dir: join(root, "project", ".kcode", "commands"), source: "project" },
      { dir: join(root, "user-commands"), source: "user" },
    ]);
    expect(await library.expand("review", "b.ts")).toBe("请审查以下内容：b.ts");
    expect(await library.expand("shared", "")).toContain("项目级版本");
    expect(await library.expand("nope", "")).toBeNull();
  });

  it("目录不存在时安静返回空", async () => {
    const commands = await discoverCommands([{ dir: join(root, "missing"), source: "user" }]);
    expect(commands).toEqual([]);
  });
});

describe("3-17 frontmatter / 命名空间 / !bash", () => {
  const roots = () => [
    { dir: join(root, "project", ".kcode", "commands"), source: "project" as const },
    { dir: join(root, "user-commands"), source: "user" as const },
  ];

  it("frontmatter 解析为元数据，正文不再含 ---", async () => {
    const parsed = parseCommandFile(
      ["---", "description: 描述", "argument-hint: <x>", "allowed-tools: [read, bash]", "model: m/1", "---", "正文"].join(
        "\n",
      ),
    );
    expect(parsed.meta).toEqual({
      description: "描述",
      argumentHint: "<x>",
      allowedTools: ["read", "bash"],
      model: "m/1",
    });
    expect(parsed.body).toBe("正文");
    expect(parsed.body).not.toContain("---");
  });

  it("递归目录生成命名空间；元数据进 list；展开只有正文", async () => {
    const library = await CommandLibrary.open(roots());
    const names = library.list().map((c) => c.name);
    expect(names).toContain("git:commit");
    expect(names).toContain("ops:deploy:prod");
    const git = library.get("git:commit");
    expect(git).toMatchObject({
      description: "提交改动",
      argumentHint: "<message>",
      allowedTools: ["read", "bash"],
      model: "glm/glm-5",
    });
    const expanded = await library.expand("git:commit", "fix bug");
    expect(expanded).toBe("提交：fix bug");
  });

  it("未闭合 frontmatter：剥掉起始 ---，不发模型", async () => {
    const library = await CommandLibrary.open(roots());
    const expanded = await library.expand("broken", "");
    expect(expanded).not.toContain("---");
    expect(expanded).toContain("正文仍在");
  });

  it("!`cmd` / !cmd 执行并按成功/失败回填；围栏内不执行", async () => {
    const calls: string[] = [];
    const bash = async (command: string) => {
      calls.push(command);
      return command.includes("fail") ? { ok: false, output: "", error: "boom" } : { ok: true, output: "M a.ts" };
    };
    const template = [
      "状态：",
      "!`git status --short`",
      "!echo hi",
      "!fail-cmd",
      "```bash",
      "!`not-run`",
      "```",
    ].join("\n");
    const expanded = await expandCommandTemplate(template, "", { bash });
    expect(calls).toEqual(["git status --short", "echo hi", "fail-cmd"]);
    expect(expanded).toContain('<bash_command command="git status --short">');
    expect(expanded).toContain("M a.ts");
    expect(expanded).toContain('ok="false"');
    expect(expanded).toContain("boom");
    expect(expanded).toContain("!`not-run`"); // 围栏内原样保留
  });

  it("无执行器时标注未执行，不把 ! 语法原样漏给模型", async () => {
    const expanded = await expandCommandTemplate("!`git status`", "");
    expect(expanded).toContain("（未执行：无 bash 执行器）");
    expect(expanded).not.toContain("!`git status`");
  });
});

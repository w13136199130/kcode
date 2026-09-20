import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommandLibrary, discoverCommands, expandCommand } from "../src/index.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-cmds-"));
  const userDir = join(root, "user-commands");
  const projectDir = join(root, "project", ".kcode", "commands");
  await mkdir(userDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(userDir, "review.md"), "请审查以下内容：$ARGUMENTS", "utf8");
  await writeFile(join(userDir, "shared.md"), "用户级版本", "utf8");
  await writeFile(join(projectDir, "shared.md"), "项目级版本（覆盖同名）", "utf8");
  await writeFile(join(projectDir, "Bad Name.md"), "不合规文件名", "utf8");
  await writeFile(join(projectDir, "notes.txt"), "非 md 忽略", "utf8");
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

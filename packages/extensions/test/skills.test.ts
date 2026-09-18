import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsSkillLibrary, discoverSkills, parseSkillMd } from "../src/index.js";

const VALID_SKILL = `---
name: code-review
description: 审查当前变更的代码质量
triggers:
  - 审查
  - code review
---
# 代码审查技能正文
逐文件检查并给出结论。
`;

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-skills-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("parseSkillMd（frontmatter 解析）", () => {
  it("解析 name/description/triggers 列表与正文", () => {
    const r = parseSkillMd(VALID_SKILL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.manifest.name).toBe("code-review");
    expect(r.skill.manifest.triggers).toEqual(["审查", "code review"]);
    expect(r.skill.body).toContain("代码审查技能正文");
  });

  it("缺 frontmatter / 未闭合 / 正文为空均报错", () => {
    expect(parseSkillMd("no frontmatter").ok).toBe(false);
    expect(parseSkillMd("---\nname: x\n").ok).toBe(false);
    expect(parseSkillMd("---\nname: x\ndescription: d\n---\n").ok).toBe(false);
  });

  it("name 不合 slug 规则被拒", () => {
    const r = parseSkillMd("---\nname: Bad Name\ndescription: d\n---\n正文");
    expect(r.ok).toBe(false);
  });
});

describe("discoverSkills（统一发现，§5.4）", () => {
  it("project > user 优先级去重；目录名与 name 不一致告警跳过", async () => {
    const projectDir = join(root, "project-skills");
    const userDir = join(root, "user-skills");
    await mkdir(join(projectDir, "code-review"), { recursive: true });
    await mkdir(join(userDir, "code-review"), { recursive: true });
    await mkdir(join(userDir, "other"), { recursive: true });
    await mkdir(join(userDir, "mismatch"), { recursive: true });
    await writeFile(join(projectDir, "code-review", "SKILL.md"), VALID_SKILL, "utf8");
    await writeFile(
      join(userDir, "code-review", "SKILL.md"),
      "---\nname: code-review\ndescription: 用户级旧版\n---\n旧正文",
      "utf8",
    );
    await writeFile(
      join(userDir, "other", "SKILL.md"),
      "---\nname: other\ndescription: 其他技能\n---\n正文",
      "utf8",
    );
    await writeFile(
      join(userDir, "mismatch", "SKILL.md"),
      "---\nname: not-mismatch\ndescription: 名字对不上\n---\n正文",
      "utf8",
    );

    const warns: string[] = [];
    const found = await discoverSkills(
      [
        { dir: projectDir, source: "project" },
        { dir: userDir, source: "user" },
      ],
      (m) => warns.push(m),
    );
    expect(found.map((s) => `${s.manifest.name}@${s.source}`).sort()).toEqual([
      "code-review@project",
      "other@user",
    ]);
    expect(warns.some((w) => w.includes("不一致"))).toBe(true);
  });
});

describe("FsSkillLibrary（渐进加载 + 触发）", () => {
  it("meta 常驻；match 命中后 body 才可读且按名缓存", async () => {
    const dir = join(root, "lib-skills");
    await mkdir(join(dir, "code-review"), { recursive: true });
    await writeFile(join(dir, "code-review", "SKILL.md"), VALID_SKILL, "utf8");

    const lib = await FsSkillLibrary.open([{ dir, source: "project" }]);
    expect(lib.meta()).toEqual([
      { name: "code-review", description: "审查当前变更的代码质量" },
    ]);
    expect(lib.match("帮我 code review 一下")).toHaveLength(1);
    expect(lib.match("随便聊聊")).toHaveLength(0);
    expect(await lib.body("code-review")).toContain("代码审查技能正文");
    await expect(lib.body("nope")).rejects.toThrow(/不存在/);
  });
});

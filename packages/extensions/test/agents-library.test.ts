import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentLibrary, parseAgentMd } from "../src/index.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-agents-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("parseAgentMd（子代理定义 frontmatter）", () => {
  it("列表形式 tools 与 model 覆盖", () => {
    const parsed = parseAgentMd(
      "finder",
      "---\ndescription: 定位标识符\ntools:\n  - read\n  - grep\nmodel: glm/glm-5.3\n---\n你是查找器。",
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.agent.manifest.description).toBe("定位标识符");
      expect(parsed.agent.manifest.tools).toEqual(["read", "grep"]);
      expect(parsed.agent.manifest.model).toBe("glm/glm-5.3");
      expect(parsed.agent.body).toBe("你是查找器。");
    }
  });

  it("逗号形式 tools 与缺省字段", () => {
    const parsed = parseAgentMd("audit", "---\ndescription: 审计\ntools: read, glob\n---\n正文");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.agent.manifest.tools).toEqual(["read", "glob"]);
      expect(parsed.agent.manifest.model).toBeUndefined();
    }
  });

  it("缺 frontmatter / 正文为空 / 名字不合法 均报错", () => {
    expect(parseAgentMd("x", "没有 frontmatter").ok).toBe(false);
    expect(parseAgentMd("x", "---\ndescription: d\n---\n").ok).toBe(false);
    expect(parseAgentMd("Bad_Name", "---\ndescription: d\n---\n正文").ok).toBe(false);
  });
});

describe("AgentLibrary（发现与优先级）", () => {
  it("扫描 .md、忽略非 md、project > user 同名先见者胜", async () => {
    const project = join(root, "proj-agents");
    const user = join(root, "user-agents");
    await mkdir(project, { recursive: true });
    await mkdir(user, { recursive: true });
    await writeFile(join(project, "finder.md"), "---\ndescription: 项目版\ntools: read\n---\n项目正文", "utf8");
    await writeFile(join(user, "finder.md"), "---\ndescription: 用户版\ntools: read\n---\n用户正文", "utf8");
    await writeFile(join(user, "audit.md"), "---\ndescription: 审计\n---\n审计正文", "utf8");
    await writeFile(join(user, "notes.txt"), "不是 md", "utf8");

    const library = await AgentLibrary.open([
      { dir: project, source: "project" },
      { dir: user, source: "user" },
    ]);
    expect(library.list().map((a) => a.name).sort()).toEqual(["audit", "finder"]);
    expect(library.get("finder")?.body).toBe("项目正文");
    expect(library.get("finder")?.source).toBe("project");
  });

  it("内置保留名不可覆盖；目录不存在按空处理", async () => {
    const dir = join(root, "reserved-agents");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "explore.md"), "---\ndescription: 假冒\n---\n正文", "utf8");
    const warnings: string[] = [];
    const library = await AgentLibrary.open([{ dir, source: "user" }], (m) => warnings.push(m));
    expect(library.get("explore")).toBeUndefined();
    expect(warnings.some((w) => w.includes("内置类型"))).toBe(true);
    const empty = await AgentLibrary.open([{ dir: join(root, "not-exist"), source: "user" }]);
    expect(empty.list()).toEqual([]);
  });
});

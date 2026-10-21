import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceKey } from "@kcode/shared";
import {
  createMemoryTool,
  createRulesTool,
  loadProjectMemory,
  loadRules,
  matchingRules,
  parseRuleFrontmatter,
  renderAlwaysRules,
  renderRuleIndex,
  ruleMatchesPath,
} from "../src/index.js";

let root: string;
let home: string;
let project: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-rules-"));
  home = join(root, "home");
  project = join(root, "project");
  await mkdir(join(home, "rules"), { recursive: true });
  await mkdir(join(project, ".kcode", "rules"), { recursive: true });
  await writeFile(
    join(home, "rules", "global.md"),
    "---\nalwaysApply: true\n---\n全局规则：先读代码再改。\n",
  );
  await writeFile(
    join(project, ".kcode", "rules", "react.md"),
    '---\ndescription: React 组件规范\npaths:\n  - "src/components/**/*.tsx"\n---\n组件使用命名导出。\n',
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("4-07 rules", () => {
  it("解析 frontmatter 的 description/paths/alwaysApply", () => {
    const parsed = parseRuleFrontmatter('---\ndescription: "x"\npaths: ["a/**", "b/*.ts"]\nalwaysApply: true\n---\nbody');
    expect(parsed.frontmatter).toEqual({ description: "x", paths: ["a/**", "b/*.ts"], alwaysApply: true });
    expect(parsed.body).toBe("body");
  });

  it("用户规则始终加载；项目规则按 trust 门控", async () => {
    const trusted = await loadRules({ cwd: project, kcodeHomeDir: home, trusted: true });
    expect(trusted.map((r) => r.name)).toEqual(["global", "react"]);
    const untrusted = await loadRules({ cwd: project, kcodeHomeDir: home, trusted: false });
    expect(untrusted.map((r) => r.name)).toEqual(["global"]);
  });

  it("paths glob 命中，且 always/index 渲染正确", async () => {
    const rules = await loadRules({ cwd: project, kcodeHomeDir: home, trusted: true });
    const react = rules.find((r) => r.name === "react")!;
    expect(ruleMatchesPath(react, join(project, "src", "components", "a.tsx"), project)).toBe(true);
    expect(ruleMatchesPath(react, join(project, "src", "components", "a.ts"), project)).toBe(false);
    expect(matchingRules(rules, "src/components/a.tsx", project).map((r) => r.name)).toEqual(["react"]);
    expect(renderAlwaysRules(rules, 1000)).toContain("全局规则");
    expect(renderRuleIndex(rules)).toContain("react");
  });

  it("项目自动记忆从 ~/.kcode/projects/<key>/memory 读取", async () => {
    const key = workspaceKey(project).replace(/[^A-Za-z0-9._-]+/g, "_");
    await mkdir(join(home, "projects", key, "memory"), { recursive: true });
    await writeFile(join(home, "projects", key, "memory", "pref.md"), "用户偏好：中文回答。\n");
    expect(await loadProjectMemory(home, project)).toContain("中文回答");
  });

  it("memory 工具 add 后可从同一目录读回", async () => {
    const tool = createMemoryTool({ kcodeHomeDir: home, cwd: project });
    const added = await tool.execute({ action: "add", text: "提交前跑 lint" }, { sessionId: "s", cwd: project });
    expect(added.ok).toBe(true);
    expect(added.output).toContain("已记住");
    const listed = await tool.execute({ action: "list" }, { sessionId: "s", cwd: project });
    expect(listed.output).toContain("提交前跑 lint");
  });

  it("rules 工具按 path 返回命中规则正文，无 path 返回索引", async () => {
    const rules = await loadRules({ cwd: project, kcodeHomeDir: home, trusted: true });
    const tool = createRulesTool({ rules, cwd: project });
    const byPath = await tool.execute({ path: "src/components/a.tsx" }, { sessionId: "s", cwd: project });
    expect(byPath.output).toContain("组件使用命名导出");
    const index = await tool.execute({}, { sessionId: "s", cwd: project });
    expect(index.output).toContain("react");
    const none = await tool.execute({ path: "src/a.ts" }, { sessionId: "s", cwd: project });
    expect(none.output).toContain("没有命中");
  });
});

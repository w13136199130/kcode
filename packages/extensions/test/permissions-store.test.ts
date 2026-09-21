import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProjectGrantStore } from "../src/index.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-perms-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ProjectGrantStore（项目级持久放行）", () => {
  it("grant 落盘且幂等，matches 按工具名命中", async () => {
    const file = join(root, "a.json");
    const store = ProjectGrantStore.open(file, join(root, "proj-a"));
    expect(await store.matches("write")).toBe(false);
    await store.grant("write");
    await store.grant("write");
    expect(await store.matches("write")).toBe(true);
    expect(await store.matches("edit")).toBe(false);
    const raw = JSON.parse(await readFile(file, "utf8")) as { projects: Record<string, string[]> };
    expect(raw.projects[join(root, "proj-a")]).toEqual(["write"]);
  });

  it("项目隔离：另一项目的放行不命中", async () => {
    const file = join(root, "b.json");
    await ProjectGrantStore.open(file, join(root, "proj-x")).grant("bash");
    const other = ProjectGrantStore.open(file, join(root, "proj-y"));
    expect(await other.matches("bash")).toBe(false);
    expect(await other.list()).toEqual([]);
  });

  it("matches 每次重读文件：另一实例 grant 后即时可见", async () => {
    const file = join(root, "c.json");
    const s1 = ProjectGrantStore.open(file, join(root, "proj-c"));
    const s2 = ProjectGrantStore.open(file, join(root, "proj-c"));
    expect(await s1.matches("edit")).toBe(false);
    await s2.grant("edit");
    expect(await s1.matches("edit")).toBe(true);
  });

  it("clear 只清本项目，保留其他项目", async () => {
    const file = join(root, "d.json");
    const projD = join(root, "proj-d");
    const projE = join(root, "proj-e");
    const s = ProjectGrantStore.open(file, projD);
    await s.grant("write");
    await ProjectGrantStore.open(file, projE).grant("bash");
    expect(await s.clear()).toBe(1);
    expect(await s.list()).toEqual([]);
    expect(await ProjectGrantStore.open(file, projE).list()).toEqual(["bash"]);
    expect(await s.clear()).toBe(0);
  });

  it("文件损坏按空处理不抛错，grant 后自愈", async () => {
    const file = join(root, "broken.json");
    await writeFile(file, "{not json", "utf8");
    const s = ProjectGrantStore.open(file, join(root, "proj-f"));
    expect(await s.list()).toEqual([]);
    expect(await s.matches("bash")).toBe(false);
    await s.grant("bash");
    expect(await s.matches("bash")).toBe(true);
  });

  it("非对象结构同样按空处理（自造内容不可自授放行）", async () => {
    const file = join(root, "weird.json");
    await writeFile(file, JSON.stringify({ v: 1, projects: { "/evil": ["bash"], bad: "x" } }), "utf8");
    const s = ProjectGrantStore.open(file, "/evil");
    // /evil 在文件里但结构合法——应命中（用户自己写的文件属于用户信任域）
    expect(await s.matches("bash")).toBe(true);
    const other = ProjectGrantStore.open(file, "/good");
    expect(await other.matches("bash")).toBe(false);
  });

  it("MCP 工具名精确命中，不误放行同前缀其他工具", async () => {
    const file = join(root, "e.json");
    const s = ProjectGrantStore.open(file, join(root, "proj-g"));
    await s.grant("mcp__fs__read_file");
    expect(await s.matches("mcp__fs__read_file")).toBe(true);
    expect(await s.matches("mcp__fs__write")).toBe(false);
  });
});

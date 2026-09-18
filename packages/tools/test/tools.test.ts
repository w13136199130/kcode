import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { globTool, grepTool, readTool } from "../src/index.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-tools-"));
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "a.txt"), "alpha\nbeta\ngamma\n", "utf8");
  await writeFile(join(root, "sub", "b.ts"), "const x = 1;\n// TODO: fix me\n", "utf8");
  await writeFile(join(root, "c.md"), "# notes\n", "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("read 工具", () => {
  it("带行号读取，支持 offset/limit 切片", async () => {
    const r = await readTool.execute({ path: "a.txt" }, { sessionId: "s", cwd: root });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("1→alpha");
    expect(r.output).toContain("3→gamma");

    const slice = await readTool.execute(
      { path: "a.txt", offset: 2, limit: 1 },
      { sessionId: "s", cwd: root },
    );
    expect(slice.output).toContain("2→beta");
    expect(slice.output).not.toContain("alpha");
  });

  it("文件不存在返回错误", async () => {
    const r = await readTool.execute({ path: "missing.txt" }, { sessionId: "s", cwd: root });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("非法参数被拒绝", async () => {
    const r = await readTool.execute({ wrong: true }, { sessionId: "s", cwd: root });
    expect(r.ok).toBe(false);
  });
});

describe("glob 工具", () => {
  it("按模式匹配并返回相对路径", async () => {
    const r = await globTool.execute({ pattern: "**/*.ts" }, { sessionId: "s", cwd: root });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("sub/b.ts");
    expect(r.output).not.toContain("a.txt");
  });

  it("无匹配返回空结果提示", async () => {
    const r = await globTool.execute({ pattern: "**/*.zzz" }, { sessionId: "s", cwd: root });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("无匹配");
  });
});

describe("grep 工具（捆绑 ripgrep）", () => {
  it("正则搜索返回 file:line:text", async () => {
    const r = await grepTool.execute({ pattern: "TODO" }, { sessionId: "s", cwd: root });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("TODO: fix me");
    expect(r.output.toLowerCase()).toContain("b.ts");
  });

  it("glob 过滤与大小写选项", async () => {
    const r = await grepTool.execute(
      { pattern: "ALPHA", ignoreCase: true },
      { sessionId: "s", cwd: root },
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("alpha");
  });

  it("无匹配不是错误", async () => {
    const r = await grepTool.execute(
      { pattern: "zzz_no_such_thing" },
      { sessionId: "s", cwd: root },
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("无匹配");
  });
});

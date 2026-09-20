import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAskPreview, renderDiff } from "../src/tools/ask-preview.js";

describe("ask 变更预览（diff 渲染）", () => {
  let ws: string;

  beforeAll(async () => {
    ws = await mkdtemp(join(tmpdir(), "kcode-preview-"));
  });
  afterAll(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("renderDiff：行级增删与上下文", () => {
    const diff = renderDiff(["a", "b", "c"], ["a", "x", "c"]);
    const lines = diff.split("\n");
    expect(lines).toContain(" a");
    expect(lines).toContain("-b");
    expect(lines).toContain("+x");
    expect(lines).not.toContain("-a");
  });

  it("edit 工具：oldString/newString 对拍", async () => {
    const preview = await buildAskPreview(
      "edit",
      { path: "src/a.ts", oldString: "foo()", newString: "bar()" },
      { sessionId: "s", cwd: ws },
    );
    expect(preview?.path).toBe("src/a.ts");
    expect(preview?.diff).toContain("-foo()");
    expect(preview?.diff).toContain("+bar()");
  });

  it("write 工具：已有文件对比旧内容；新文件整体为新增", async () => {
    const existing = join(ws, "existing.txt");
    await writeFile(existing, "line1\nline2\n", "utf8");
    const modified = await buildAskPreview(
      "write",
      { path: existing, content: "line1\nchanged\n" },
      { sessionId: "s", cwd: ws },
    );
    expect(modified?.diff).toContain("-line2");
    expect(modified?.diff).toContain("+changed");
    expect(modified?.diff).toContain(" line1");

    const created = await buildAskPreview(
      "write",
      { path: join(ws, "brand-new.txt"), content: "fresh" },
      { sessionId: "s", cwd: ws },
    );
    expect(created?.diff.split("\n")).toEqual(["+fresh"]);
  });

  it("非写/编辑工具无预览；超长 diff 截断", async () => {
    expect(await buildAskPreview("bash", { command: "ls" }, { sessionId: "s", cwd: ws })).toBeUndefined();
    const long = renderDiff([], Array.from({ length: 100 }, (_, i) => `l${i}`));
    expect(long).toContain("…（其余");
  });
});

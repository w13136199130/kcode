import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FileReadRecord, ToolContext } from "@kcode/contracts";
import { editTool } from "../src/tools/edit.js";
import { readTool } from "../src/tools/read.js";
import { writeTool } from "../src/tools/write.js";

let root: string;
const reads = new Map<string, FileReadRecord>();
const ctx = (): ToolContext => ({ sessionId: "s", cwd: root, reads });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-read-before-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("3-09 read-before-write", () => {
  it("未 read 直接 edit 被拒绝；read 后可编辑且连续编辑无需重读", async () => {
    const file = join(root, "a.ts");
    await writeFile(file, "const a = 1;\n", "utf8");
    const denied = await editTool.execute({ path: file, oldString: "1", newString: "2" }, ctx());
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("尚未读取");

    expect((await readTool.execute({ path: file }, ctx())).ok).toBe(true);
    const first = await editTool.execute({ path: file, oldString: "1", newString: "2" }, ctx());
    expect(first.ok).toBe(true);
    const second = await editTool.execute({ path: file, oldString: "2", newString: "3" }, ctx());
    expect(second.ok).toBe(true);
    expect(await readFile(file, "utf8")).toContain("3");
  });

  it("read 后文件被外部修改：edit 拒绝并提示重读", async () => {
    const file = join(root, "b.ts");
    await writeFile(file, "old", "utf8");
    await readTool.execute({ path: file }, ctx());
    await writeFile(file, "external", "utf8");
    const denied = await editTool.execute({ path: file, oldString: "external", newString: "x" }, ctx());
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("已被修改");
  });

  it("write 新建文件免读；覆盖已存在文件需 read", async () => {
    const fresh = join(root, "new.ts");
    expect((await writeTool.execute({ path: fresh, content: "v1" }, ctx())).ok).toBe(true);

    const existing = join(root, "existing.ts");
    await writeFile(existing, "old", "utf8");
    const denied = await writeTool.execute({ path: existing, content: "new" }, ctx());
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("尚未读取");

    await readTool.execute({ path: existing }, ctx());
    expect((await writeTool.execute({ path: existing, content: "new" }, ctx())).ok).toBe(true);
    expect(await readFile(existing, "utf8")).toBe("new");
  });
});

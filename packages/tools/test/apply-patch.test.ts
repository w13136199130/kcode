import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FileReadRecord, ToolContext } from "@kcode/contracts";
import { applyPatchTool } from "../src/tools/apply-patch.js";
import { readTool } from "../src/tools/read.js";

let root: string;
const reads = new Map<string, FileReadRecord>();
const ctx = (): ToolContext => ({ sessionId: "s", cwd: root, reads });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-apply-patch-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("3-07 apply_patch", () => {
  it("多文件新增/修改/删除一次提交", async () => {
    const keep = join(root, "keep.txt");
    const gone = join(root, "gone.txt");
    await writeFile(keep, "old\n", "utf8");
    await writeFile(gone, "bye\n", "utf8");
    await readTool.execute({ path: keep }, ctx());
    await readTool.execute({ path: gone }, ctx());

    const result = await applyPatchTool.execute(
      {
        patch: [
          "*** Begin Patch",
          "*** Add File: new.txt",
          "+hello",
          "*** Update File: keep.txt",
          "@@",
          "-old",
          "+new",
          "*** Delete File: gone.txt",
          "*** End Patch",
        ].join("\n"),
      },
      ctx(),
    );
    expect(result.ok).toBe(true);
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("hello\n");
    expect(await readFile(keep, "utf8")).toBe("new\n");
    await expect(readFile(gone, "utf8")).rejects.toThrow();
  });

  it("任一步校验失败：整体不落盘", async () => {
    const addOnly = join(root, "should-not-exist.txt");
    const result = await applyPatchTool.execute(
      {
        patch: [
          "*** Begin Patch",
          "*** Add File: should-not-exist.txt",
          "+x",
          "*** Update File: keep.txt",
          "@@",
          "-not-present",
          "+y",
          "*** End Patch",
        ].join("\n"),
      },
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("找不到 hunk");
    await expect(readFile(addOnly, "utf8")).rejects.toThrow();
  });

  it("修改未 read 文件被拒绝", async () => {
    const file = join(root, "unread.txt");
    await writeFile(file, "a\n", "utf8");
    const result = await applyPatchTool.execute(
      { patch: ["*** Begin Patch", "*** Update File: unread.txt", "@@", "-a", "+b", "*** End Patch"].join("\n") },
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("尚未读取");
  });
});

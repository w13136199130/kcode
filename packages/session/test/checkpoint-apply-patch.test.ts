import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPatchTool, resolveInCtx } from "@kcode/tools";
import { CheckpointStore } from "../src/checkpoints.js";
import { withFileCheckpoints } from "../src/checkpoints.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-patch-checkpoint-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("3-07 apply_patch 检查点", () => {
  it("一个 callId 为多个文件留前像，rewind 可全部恢复", async () => {
    const a = join(root, "a.txt");
    const b = join(root, "b.txt");
    await writeFile(a, "a0\n", "utf8");
    await writeFile(b, "b0\n", "utf8");
    const store = await CheckpointStore.open(join(root, "cp"));
    const tool = withFileCheckpoints(applyPatchTool, store, resolveInCtx);
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-a0",
      "+a1",
      "*** Update File: b.txt",
      "@@",
      "-b0",
      "+b1",
      "*** End Patch",
    ].join("\n");
    const result = await tool.execute({ patch }, { sessionId: "s", callId: "p1", cwd: root });
    expect(result.ok).toBe(true);
    const entries = store.byCall("p1");
    expect(entries).toHaveLength(2);

    await store.restore(entries.map((e) => e.callId));
    expect(await readFile(a, "utf8")).toBe("a0\n");
    expect(await readFile(b, "utf8")).toBe("b0\n");
  });
});

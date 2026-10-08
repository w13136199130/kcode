import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { atomicWriteText } from "../src/tools/atomic-write.js";
import { editTool, writeTool } from "../src/index.js";

/**
 * N3I-1 原子写：tmp+rename 语义——成功后内容完整、目录无临时文件残留、
 * mode 继承（posix）；工具层（write/edit）切换后行为不回归。
 */

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-atomic-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const tmpLeftovers = async (dir: string): Promise<string[]> =>
  (await readdir(dir)).filter((f) => f.includes(".tmp-"));

describe("atomicWriteText", () => {
  it("新建与覆盖：内容完整、无临时文件残留", async () => {
    const file = join(root, "a.txt");
    await atomicWriteText(file, "first");
    await atomicWriteText(file, "second\nmultiline\n");
    expect(await readFile(file, "utf8")).toBe("second\nmultiline\n");
    expect(await tmpLeftovers(root)).toEqual([]);
  });

  it("覆盖前旧内容要么保留要么整体替换（rename 语义下不会共存）", async () => {
    const file = join(root, "b.txt");
    await writeFile(file, "old-content", "utf8");
    await atomicWriteText(file, "new-content");
    expect(await readFile(file, "utf8")).toBe("new-content");
    expect(await tmpLeftovers(root)).toEqual([]);
  });

  it.runIf(process.platform !== "win32")("继承原文件 mode（保执行位）", async () => {
    const file = join(root, "exec.sh");
    await writeFile(file, "#!/bin/sh\n", "utf8");
    await chmod(file, 0o755);
    await atomicWriteText(file, "#!/bin/sh\necho ok\n");
    expect((await stat(file)).mode & 0o777).toBe(0o755);
  });

  it("大内容写入完整（fsync 路径不丢尾）", async () => {
    const file = join(root, "big.txt");
    const content = "x".repeat(300_000);
    await atomicWriteText(file, content);
    expect(await readFile(file, "utf8")).toBe(content);
  });
});

describe("工具层切换（write/edit 走原子写）", () => {
  const ctx = (): { sessionId: string; cwd: string } => ({ sessionId: "s", cwd: root });

  it("write 覆盖后内容完整且无 tmp 残留", async () => {
    const r = await writeTool.execute({ path: "w.txt", content: "v1" }, ctx());
    expect(r.ok).toBe(true);
    const r2 = await writeTool.execute({ path: "w.txt", content: "v2\n" }, ctx());
    expect(r2.ok).toBe(true);
    expect(await readFile(join(root, "w.txt"), "utf8")).toBe("v2\n");
    expect(await tmpLeftovers(root)).toEqual([]);
  });

  it("edit 精确与模糊替换后内容完整且无 tmp 残留", async () => {
    await writeFile(join(root, "e.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const r = await editTool.execute(
      { path: "e.txt", oldString: "beta", newString: "BETA" },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(await readFile(join(root, "e.txt"), "utf8")).toBe("alpha\nBETA\ngamma\n");
    expect(await tmpLeftovers(root)).toEqual([]);
  });
});

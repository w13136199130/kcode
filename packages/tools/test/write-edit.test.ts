import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { editTool, writeTool } from "../src/index.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-write-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const ctx = (): { sessionId: string; cwd: string } => ({ sessionId: "s", cwd: root });

describe("write 工具", () => {
  it("创建文件（含父目录）与覆盖", async () => {
    const created = await writeTool.execute(
      { path: "nested/dir/a.txt", content: "line1\nline2\n" },
      ctx(),
    );
    expect(created.ok).toBe(true);
    expect(await readFile(join(root, "nested/dir/a.txt"), "utf8")).toBe("line1\nline2\n");

    const overwritten = await writeTool.execute(
      { path: "nested/dir/a.txt", content: "replaced" },
      ctx(),
    );
    expect(overwritten.ok).toBe(true);
    expect(overwritten.output).toContain("nested");
    expect(await readFile(join(root, "nested/dir/a.txt"), "utf8")).toBe("replaced");
  });

  it("非法参数被拒绝", async () => {
    const r = await writeTool.execute({ path: "x.txt" }, ctx());
    expect(r.ok).toBe(false);
  });
});

describe("edit 工具", () => {
  it("唯一精确匹配替换；$ 元字符不生效", async () => {
    const file = join(root, "exact.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const r = await editTool.execute(
      { path: "exact.txt", oldString: "beta", newString: "B$&E" },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(await readFile(file, "utf8")).toBe("alpha\nB$&E\ngamma\n");
  });

  it("3-08 replaceAll 替换全部精确匹配；默认仍拒绝歧义", async () => {
    const file = join(root, "all.txt");
    await writeFile(file, "x\nx\nx\n", "utf8");
    const denied = await editTool.execute({ path: "all.txt", oldString: "x", newString: "y" }, ctx());
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("不唯一");

    const all = await editTool.execute(
      { path: "all.txt", oldString: "x", newString: "y", replaceAll: true },
      ctx(),
    );
    expect(all.ok).toBe(true);
    expect(all.output).toContain("替换全部");
    expect(await readFile(file, "utf8")).toBe("y\ny\ny\n");
  });

  it("3-08 edits[] 多编辑按序应用；任一处失败整体不写", async () => {
    const file = join(root, "multi.txt");
    await writeFile(file, "a\nb\nc\n", "utf8");
    const ok = await editTool.execute(
      {
        path: "multi.txt",
        edits: [
          { oldString: "a", newString: "A" },
          { oldString: "c", newString: "C" },
        ],
      },
      ctx(),
    );
    expect(ok.ok).toBe(true);
    expect(await readFile(file, "utf8")).toBe("A\nb\nC\n");

    const failed = await editTool.execute(
      {
        path: "multi.txt",
        edits: [
          { oldString: "A", newString: "X" },
          { oldString: "missing", newString: "Y", replaceAll: true },
        ],
      },
      ctx(),
    );
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("第 2 处");
    expect(await readFile(file, "utf8")).toBe("A\nb\nC\n"); // 第一处也不落盘
  });

  it("CRLF 文件用 LF oldString 仍走精确匹配（不落到模糊）", async () => {
    const file = join(root, "crlf-exact.txt");
    await writeFile(file, "alpha\r\nbeta\r\ngamma\r\n", "utf8");
    const r = await editTool.execute(
      { path: "crlf-exact.txt", oldString: "alpha\nbeta", newString: "ALPHA\nBETA" },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("精确匹配");
    expect(await readFile(file, "utf8")).toBe("ALPHA\r\nBETA\r\ngamma\r\n");
  });

  it("多处出现报不唯一", async () => {
    const file = join(root, "dup.txt");
    await writeFile(file, "x\nx\n", "utf8");
    const r = await editTool.execute({ path: "dup.txt", oldString: "x", newString: "y" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("不唯一");
  });

  it("模糊匹配容忍空白差异并保留 EOL 风格", async () => {
    const file = join(root, "fuzzy.txt");
    await writeFile(file, "const a = 1;   \r\nconst b = 2;\r\n", "utf8");
    const r = await editTool.execute(
      { path: "fuzzy.txt", oldString: "const a = 1;\nconst b = 2;", newString: "const a = 11;\nconst b = 22;" },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("模糊匹配");
    expect(await readFile(file, "utf8")).toBe("const a = 11;\r\nconst b = 22;\r\n");
  });

  it("完全无匹配时报错；fuzzy=false 跳过模糊", async () => {
    const file = join(root, "nomatch.txt");
    await writeFile(file, "aaa\nbbb\n", "utf8");
    const r = await editTool.execute(
      { path: "nomatch.txt", oldString: "zzz", newString: "y" },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("未找到");

    const strict = await editTool.execute(
      { path: "nomatch.txt", oldString: "zzz", newString: "y", fuzzy: false },
      ctx(),
    );
    expect(strict.ok).toBe(false);
    expect(strict.error).toContain("fuzzy=false");
  });

  it("文件不存在报错", async () => {
    const r = await editTool.execute(
      { path: "missing.txt", oldString: "a", newString: "b" },
      ctx(),
    );
    expect(r.ok).toBe(false);
  });
});

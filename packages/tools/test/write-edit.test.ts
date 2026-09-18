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

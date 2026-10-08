import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendMemoryLine } from "../src/tui/memory.js";

/** N3G-3：# 快捷记忆——AGENTS.md 追加与空行分隔 */

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "kcode-memory-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("appendMemoryLine", () => {
  it("文件不存在：创建并写入单行", async () => {
    const path = await appendMemoryLine(dir, "构建用 pnpm，不要 npm");
    expect(path).toBe(join(dir, "AGENTS.md"));
    expect(await readFile(path, "utf8")).toBe("构建用 pnpm，不要 npm\n");
  });

  it("已有内容以换行结尾：补一个空行再追加", async () => {
    await appendMemoryLine(dir, "第二行记忆");
    const text = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(text).toBe("构建用 pnpm，不要 npm\n\n第二行记忆\n");
  });

  it("已有内容无尾换行：两个换行隔开；已是双换行结尾不再加", async () => {
    const d2 = join(dir, "case3");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(d2, { recursive: true });
    await writeFile(join(d2, "AGENTS.md"), "已有内容", "utf8");
    await appendMemoryLine(d2, "追加");
    expect(await readFile(join(d2, "AGENTS.md"), "utf8")).toBe("已有内容\n\n追加\n");
    await appendMemoryLine(d2, "再追加");
    expect(await readFile(join(d2, "AGENTS.md"), "utf8")).toBe("已有内容\n\n追加\n\n再追加\n");
  });
});

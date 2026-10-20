import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";

let root: string;
const ctx = (): { sessionId: string; cwd: string } => ({ sessionId: "s", cwd: root });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-grep-glob-"));
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "dist/\n", "utf8");
  await writeFile(
    join(root, "a.ts"),
    ["before", "needle one", "after", "needle two", "needle three"].join("\n"),
    "utf8",
  );
  await writeFile(join(root, "b.ts"), ["needle four", "needle five", "needle six"].join("\n"), "utf8");
  await writeFile(join(root, "c.md"), "needle docs\n", "utf8");
  await writeFile(join(root, "dist", "ignored.ts"), "needle ignored\n", "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("3-11 grep/glob", () => {
  it("grep 上下文行与 fileType", async () => {
    const r = await grepTool.execute({ pattern: "needle", path: "a.ts", context: 1 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("before");
    expect(r.output).toContain("after");

    const typed = await grepTool.execute({ pattern: "needle", fileType: "ts" }, ctx());
    expect(typed.output).not.toContain("c.md");
    expect(typed.output).toContain("a.ts");
  });

  it("grep 总匹配上限截断并提示", async () => {
    const r = await grepTool.execute({ pattern: "needle", maxResults: 2 }, ctx());
    expect(r.ok).toBe(true);
    const matches = r.output.split("\n").filter((l) => /:\d+:/.test(l));
    expect(matches.length).toBeLessThanOrEqual(2);
    expect(r.output).toContain("仅显示前 2 个匹配");
  });

  it("glob 支持 ** 并遵循 .gitignore 的 dist/", async () => {
    const r = await globTool.execute({ pattern: "**/*.ts", path: "." }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("a.ts");
    expect(r.output).toContain("b.ts");
    expect(r.output).not.toContain("dist/ignored.ts");
  });
});

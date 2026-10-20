import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchWorkspaceFiles } from "../src/files.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-host-files-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "src", "app.ts"), "export {};\n", "utf8");
  await writeFile(join(root, "src", "README.md"), "# hi\n", "utf8");
  await writeFile(join(root, "node_modules", "pkg", "index.js"), "", "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("D1-05 @ 文件补全索引", () => {
  it("按 query 过滤、前缀优先、跳过 node_modules", async () => {
    const all = await searchWorkspaceFiles(root, "");
    expect(all).toContain("src/app.ts");
    expect(all.some((f) => f.includes("node_modules"))).toBe(false);

    const app = await searchWorkspaceFiles(root, "app");
    expect(app).toEqual(["src/app.ts"]);

    const readme = await searchWorkspaceFiles(root, "readme");
    expect(readme).toEqual(["src/README.md"]);
  });
});

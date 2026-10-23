import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRepoMap, repoMapTool } from "../src/index.js";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-repomap-"));
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export function alpha() {}\nexport class Beta {}\n", "utf8");
  await writeFile(join(root, "src", "b.py"), "class Gamma:\n    pass\n\ndef delta():\n    pass\n", "utf8");
  await writeFile(join(root, "src", "nested", "c.ts"), "export const epsilon = 1;\n", "utf8");
  await writeFile(join(root, "src", "control.ts"), "export function real() { if (x) return 1; for (;;) break; }\n", "utf8");
  await writeFile(join(root, "node_modules", "ignored", "bad.ts"), "export function shouldNotAppear() {}\n", "utf8");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("repo map（4-04）", () => {
  it("提取 TS/Python 符号并按目录展示，忽略 node_modules", async () => {
    const map = await buildRepoMap(root, { refresh: true });
    expect(map).toContain("src/");
    expect(map).toContain("a.ts: alpha, Beta");
    expect(map).toContain("b.py: Gamma, delta");
    expect(map).toContain("nested/");
    expect(map).toContain("c.ts: epsilon");
    expect(map).toContain("control.ts: real");
    expect(map).not.toMatch(/\bif\b|\bfor\b/);
    expect(map).not.toContain("shouldNotAppear");
  });

  it("遵守字符预算", async () => {
    const map = await buildRepoMap(root, { refresh: true, maxChars: 500 });
    expect(map.length).toBeLessThanOrEqual(500);
  });

  it("repo_map 工具使用 ctx.cwd", async () => {
    const result = await repoMapTool.execute({ refresh: true }, { sessionId: "s", cwd: root });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("a.ts");
  });
});

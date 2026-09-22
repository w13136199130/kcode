import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { filterFileCandidates, listProjectFiles } from "../src/tui/file-complete.js";
import { appendHistory, loadInputHistory, saveInputHistory } from "../src/history-store.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-b4-"));
  await writeFile(join(root, "package.json"), "{}", "utf8");
  await writeFile(join(root, "readme.md"), "# r", "utf8");
  await mkdir(join(root, "apps", "cli"), { recursive: true });
  await writeFile(join(root, "apps", "cli", "main.tsx"), "x", "utf8");
  await mkdir(join(root, "node_modules", "junk"), { recursive: true });
  await writeFile(join(root, "node_modules", "junk", "noise.js"), "x", "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("@ 文件补全（B4）", () => {
  it("列举项目文件：排除 node_modules，路径用 / 分隔，浅层优先", async () => {
    const files = await listProjectFiles(root);
    expect(files).toContain("package.json");
    expect(files).toContain("apps/cli/main.tsx");
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    const flatIndex = files.indexOf("package.json");
    const deepIndex = files.indexOf("apps/cli/main.tsx");
    expect(flatIndex).toBeLessThan(deepIndex);
  });

  it("过滤：前缀优先于子串；空查询只出顶层文件", () => {
    const files = ["package.json", "readme.md", "apps/cli/main.tsx", "pnpm-workspace.yaml"];
    expect(filterFileCandidates(files, "pack")).toEqual(["package.json"]);
    expect(filterFileCandidates(files, "main")[0]).toBe("apps/cli/main.tsx");
    expect(filterFileCandidates(files, "")).toEqual(["package.json", "readme.md", "pnpm-workspace.yaml"]);
    expect(filterFileCandidates(files, "zzz")).toEqual([]);
  });
});

describe("输入历史持久化（B4）", () => {
  it("append 去连续重；save/load 往返；损坏文件按空", async () => {
    let entries: string[] = [];
    entries = appendHistory(entries, "第一条");
    entries = appendHistory(entries, "第一条"); // 连续重复跳过
    entries = appendHistory(entries, "  第二条  "); // 首尾空白规整
    expect(entries).toEqual(["第一条", "第二条"]);
    const file = join(root, "history.json"); // 测试注入路径，不碰真实 ~/.kcode
    await saveInputHistory(entries, file);
    const loaded = await loadInputHistory(file);
    expect(loaded).toEqual(["第一条", "第二条"]);
    await writeFile(file, "{broken", "utf8");
    expect(await loadInputHistory(file)).toEqual([]);
  });
});

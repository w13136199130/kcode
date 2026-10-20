import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  diffStats,
  filterChanges,
  normalizeForMatch,
  parseDiff,
  relativePath,
  toHunks,
} from "../src/tui/dialogs/diff-model.js";

/** 3-23 /diff 数据层：hunk 折叠/行号/统计/路径筛选（面板与 App 共用的纯函数） */

describe("parseDiff / diffStats", () => {
  it("按行首标记分类并统计 +/-；截断提示不计数", () => {
    const diff = [" 1", "-old", "+new", "+", " 2", "…（其余 5 行省略）"].join("\n");
    const lines = parseDiff(diff);
    expect(lines.map((l) => l.kind)).toEqual([" ", "-", "+", "+", " ", "!"]);
    expect(lines[2]).toMatchObject({ text: "new", newNo: 2 });
    expect(lines[3]).toMatchObject({ text: "" }); // 新增空行
    expect(diffStats(diff)).toMatchObject({ additions: 2, deletions: 1 });
  });

  it("空 diff 不产生行/hunk", () => {
    expect(parseDiff("")).toEqual([]);
    expect(diffStats("")).toEqual({ additions: 0, deletions: 0, hunks: 0 });
    expect(toHunks("")).toEqual([]);
  });
});

describe("toHunks", () => {
  it("只保留改动前后 3 行上下文，行号头按 git 语义计算", () => {
    const diff = [" 1", " 2", " 3", " 4", "-old5", "+new5", " 6", " 7", " 8", " 9", " 10"].join("\n");
    const hunks = toHunks(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.header).toBe("@@ -2,7 +2,7 @@");
    expect(hunks[0]!.lines.map((l) => `${l.kind}${l.text}`)).toEqual([
      " 2",
      " 3",
      " 4",
      "-old5",
      "+new5",
      " 6",
      " 7",
      " 8",
    ]);
  });

  it("两处相距较远的改动拆成两个 hunk，重叠窗口合并", () => {
    const before = Array.from({ length: 24 }, (_, i) => ` ${i + 1}`);
    before[1] = "-old2";
    before[15] = "-old16";
    const hunks = toHunks(before.join("\n"));
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.header).toBe("@@ -1,5 +1,4 @@");
    expect(hunks[1]!.header).toBe("@@ -13,7 +12,6 @@");

    // 相邻改动（窗口重叠）不拆
    const merged = toHunks([" 1", "-a", "-b", "+c", " 2"].join("\n"));
    expect(merged).toHaveLength(1);
  });

  it("新建文件旧侧为空，整篇删除新侧为空", () => {
    expect(toHunks("+a\n+b\n+c")[0]!.header).toBe("@@ -0,0 +1,3 @@");
    expect(toHunks("-a\n-b")[0]!.header).toBe("@@ -1,2 +0,0 @@");
  });

  it("context=0 时纯插入 hunk 的旧起点为插入位置之前", () => {
    const hunks = toHunks([" 1", " 2", "+x", " 3"].join("\n"), 0);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.header).toBe("@@ -2,0 +3,1 @@");
    expect(hunks[0]!.lines.map((l) => l.kind)).toEqual(["+"]);
  });
});

describe("路径展示与 /diff 筛选", () => {
  const cwd = process.cwd();
  const changes = [
    { path: join(cwd, "src", "auth.ts") },
    { path: join(cwd, "docs", "guide.md") },
  ];

  it("工作区内路径转相对 + 正斜杠", () => {
    expect(relativePath(join(cwd, "src", "auth.ts"), cwd)).toBe("src/auth.ts");
  });

  it("空查询全量；反斜杠/大小写不影响子串匹配", () => {
    expect(filterChanges(changes, "", cwd)).toHaveLength(2);
    expect(filterChanges(changes, "AUTH", cwd).map((c) => c.path)).toEqual([changes[0]!.path]);
    expect(filterChanges(changes, "src\\auth", cwd).map((c) => c.path)).toEqual([changes[0]!.path]);
    expect(filterChanges(changes, "nope", cwd)).toEqual([]);
  });

  it("匹配归一化同时覆盖绝对路径", () => {
    expect(normalizeForMatch("E:\\Work\\A.TS")).toBe("e:/work/a.ts");
    expect(filterChanges(changes, cwd.replace(/\\/g, "/"), cwd)).toHaveLength(2);
  });

  it("相对查询不看工作区目录名（避免目录名把子串查询放大成全命中）", () => {
    const base = cwd.split(/[\\/]/).at(-1) ?? "";
    if (base !== "" && !changes.some((c) => c.path.includes(base))) {
      expect(filterChanges(changes, base, cwd)).toEqual([]);
    }
  });
});

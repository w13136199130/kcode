import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usageLedger } from "../src/usage-ledger.js";
import { extensionsOverview } from "../src/extensions-overview.js";

/** S2-6 第一片：跨会话用量账本（尾部估算）。 */
describe("usage ledger（S1-6/S2-6）", () => {
  it("聚合各会话 session_end.usage 并按模型分组；无结束轮的会话不计", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kcode-ledger-"));
    try {
      await writeFile(
        join(dir, "s1.jsonl"),
        [
          JSON.stringify({ v: 1, type: "session_start", ts: 1, sessionId: "s1", model: "mock/a" }),
          JSON.stringify({ v: 1, type: "user_message", ts: 2, sessionId: "s1", content: "hi" }),
          JSON.stringify({ v: 1, type: "session_end", ts: 3, sessionId: "s1", reason: "completed", usage: { inputTokens: 100, outputTokens: 50, calls: 2 } }),
          JSON.stringify({ v: 1, type: "session_end", ts: 4, sessionId: "s1", reason: "completed", usage: { inputTokens: 10, outputTokens: 5, calls: 1 } }),
        ].join("\n") + "\n",
        "utf8",
      );
      await writeFile(
        join(dir, "s2.jsonl"),
        [
          JSON.stringify({ v: 1, type: "session_start", ts: 1, sessionId: "s2", model: "mock/b" }),
          JSON.stringify({ v: 1, type: "session_end", ts: 2, sessionId: "s2", reason: "completed", usage: { inputTokens: 1000, outputTokens: 500, calls: 9 } }),
        ].join("\n") + "\n",
        "utf8",
      );
      await writeFile(
        join(dir, "s3.jsonl"),
        [JSON.stringify({ v: 1, type: "session_start", ts: 1, sessionId: "s3", model: "mock/c" })].join("\n") + "\n",
        "utf8",
      );
      const ledger = await usageLedger(dir);
      expect(ledger.approximate).toBe(true);
      expect(ledger.sessions).toBe(2);
      expect(ledger.totals).toEqual({ inputTokens: 1110, outputTokens: 555, calls: 12 });
      expect(ledger.byModel).toEqual([
        { model: "mock/b", inputTokens: 1000, outputTokens: 500, calls: 9 },
        { model: "mock/a", inputTokens: 110, outputTokens: 55, calls: 3 },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    }
  });

  it("目录不存在时返回空账本", async () => {
    const ledger = await usageLedger(join(tmpdir(), "kcode-ledger-missing"));
    expect(ledger.sessions).toBe(0);
    expect(ledger.byModel).toEqual([]);
  });
});

/** S1-6：扩展一站式清单（技能/命令/用户级 MCP；插件在 E2E 用真实目录覆盖）。 */
describe("extensions overview（S1-6）", () => {
  it("列出用户级技能/命令/MCP；项目级来源未信任时不出现", async () => {
    const home = await mkdtemp(join(tmpdir(), "kcode-ext-"));
    const project = await mkdtemp(join(tmpdir(), "kcode-ext-proj-"));
    try {
      await mkdir(join(home, "skills", "demo"), { recursive: true });
      await writeFile(
        join(home, "skills", "demo", "SKILL.md"),
        "---\nname: demo\ndescription: 演示技能\n---\n正文",
        "utf8",
      );
      await mkdir(join(home, "commands"), { recursive: true });
      await writeFile(join(home, "commands", "review.md"), "---\ndescription: 审查当前改动\n---\n内容", "utf8");
      await writeFile(join(home, "mcp.json"), JSON.stringify({ servers: [{ name: "fs", transport: "stdio", command: "npx", args: [] }] }), "utf8");
      // 未信任项目里的技能/命令不应出现
      await mkdir(join(project, ".kcode", "skills", "secret"), { recursive: true });
      await writeFile(join(project, ".kcode", "skills", "secret", "SKILL.md"), "---\nname: secret\ndescription: 不应出现\n---\nx", "utf8");

      const overview = await extensionsOverview(home, project);
      expect(overview.skills.map((s) => s.name)).toEqual(["demo"]);
      expect(overview.commands.map((c) => c.name)).toEqual(["review"]);
      expect(overview.mcp.user).toEqual([{ name: "fs", transport: "stdio" }]);
      expect(overview.mcp.project).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
      await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    }
  });
});

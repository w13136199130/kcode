import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionsCommand } from "../src/sessions-command.js";

let home: string;
let cwd: string;
let dir: string;

const line = (event: object): string => `${JSON.stringify({ v: 1, ts: 0, sessionId: "s", ...event })}\n`;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-sessions-home-"));
  cwd = await mkdtemp(join(tmpdir(), "kcode-sessions-cwd-"));
  dir = join(home, "cli", "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "sess_alpha.jsonl"),
    line({ type: "session_start", workspaceKey: cwd.replace(/\\/g, "/"), model: "m" }) +
      line({ type: "user_message", content: "alpha 首问" }),
  );
  await writeFile(
    join(dir, "sess_beta.jsonl"),
    line({ type: "session_start", workspaceKey: cwd.replace(/\\/g, "/"), model: "m" }) +
      line({ type: "user_message", content: "beta 首问" }),
  );
  await writeFile(
    join(dir, "sess_other.jsonl"),
    line({ type: "session_start", workspaceKey: "D:/other-project", model: "m" }) +
      line({ type: "user_message", content: "other 首问" }),
  );
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

describe("3-04 kcode sessions", () => {
  it("list 只显示当前项目；rename latest 后显示标题", async () => {
    const lines: string[] = [];
    expect(await sessionsCommand(cwd, home, ["list"], (l) => lines.push(l))).toBe(true);
    const text = lines.join("\n");
    expect(text).toContain("sess_alpha");
    expect(text).toContain("sess_beta");
    expect(text).not.toContain("sess_other");

    const renamed: string[] = [];
    expect(await sessionsCommand(cwd, home, ["rename", "sess_alpha", "部署", "排查"], (l) => renamed.push(l))).toBe(true);
    const after: string[] = [];
    await sessionsCommand(cwd, home, ["list"], (l) => after.push(l));
    expect(after.join("\n")).toContain("部署 排查");
  });

  it("前缀命中、前缀歧义与删除", async () => {
    const lines: string[] = [];
    expect(await sessionsCommand(cwd, home, ["rename", "sess_a", "x"], (l) => lines.push(l))).toBe(true);
    const ambiguous = await sessionsCommand(cwd, home, ["rename", "sess_", "x"], (l) => lines.push(l));
    expect(ambiguous).toBe(false);
    expect(lines.join("\n")).toContain("不唯一");

    const removed: string[] = [];
    expect(await sessionsCommand(cwd, home, ["rm", "sess_beta"], (l) => removed.push(l))).toBe(true);
    const after: string[] = [];
    await sessionsCommand(cwd, home, ["list"], (l) => after.push(l));
    expect(after.join("\n")).not.toContain("sess_beta");
  });

  it("3-30 vacuum（dry-run/应用）与 rm 级联清理", async () => {
    const vacHome = await mkdtemp(join(tmpdir(), "kcode-vacuum-home-"));
    const vacCwd = await mkdtemp(join(tmpdir(), "kcode-vacuum-cwd-"));
    const vacDir = join(vacHome, "cli", "sessions");
    await mkdir(vacDir, { recursive: true });
    for (const [id, ageDays] of [
      ["vac_a", 2],
      ["vac_b", 1],
    ] as const) {
      const path = join(vacDir, `${id}.jsonl`);
      await writeFile(
        path,
        line({ type: "session_start", workspaceKey: vacCwd.replace(/\\/g, "/"), model: "m" }) +
          line({ type: "user_message", content: id }),
      );
      const at = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
      await utimes(path, at, at);
      await mkdir(join(vacHome, "cli", "artifacts", id), { recursive: true });
      await writeFile(join(vacHome, "cli", "artifacts", id, "log.txt"), "x");
      await mkdir(join(vacHome, "cli", "audit"), { recursive: true });
      await writeFile(join(vacHome, "cli", "audit", `${id}.jsonl`), "{}\n");
    }
    try {
      const dry: string[] = [];
      expect(await sessionsCommand(vacCwd, vacHome, ["vacuum", "--dry-run", "--max-sessions", "1"], (l) => dry.push(l))).toBe(true);
      expect(dry.join("\n")).toContain("dry-run");
      expect(existsSync(join(vacDir, "vac_a.jsonl"))).toBe(true);

      const applied: string[] = [];
      await sessionsCommand(vacCwd, vacHome, ["vacuum", "--max-sessions", "1"], (l) => applied.push(l));
      expect(applied.join("\n")).toContain("删除会话 1 个");
      expect(existsSync(join(vacDir, "vac_a.jsonl"))).toBe(false);
      expect(existsSync(join(vacHome, "cli", "artifacts", "vac_a"))).toBe(false);

      const removed: string[] = [];
      await sessionsCommand(vacCwd, vacHome, ["rm", "vac_b"], (l) => removed.push(l));
      expect(removed.join("\n")).toContain("连带释放");
      expect(existsSync(join(vacHome, "cli", "artifacts", "vac_b"))).toBe(false);
      expect(existsSync(join(vacHome, "cli", "audit", "vac_b.jsonl"))).toBe(false);
    } finally {
      await rm(vacHome, { recursive: true, force: true });
      await rm(vacCwd, { recursive: true, force: true });
    }
  });
});

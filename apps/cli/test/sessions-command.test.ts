import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
});

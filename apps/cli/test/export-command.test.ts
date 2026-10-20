import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportCommand } from "../src/export-command.js";

let home: string;
let cwd: string;
let dir: string;

const line = (event: object): string => `${JSON.stringify({ v: 1, ts: 0, sessionId: "s", ...event })}\n`;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-export-home-"));
  cwd = await mkdtemp(join(tmpdir(), "kcode-export-cwd-"));
  dir = join(home, "cli", "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "sess_export.jsonl"),
    line({ type: "session_start", workspaceKey: cwd.replace(/\\/g, "/"), model: "m" }) +
      line({ type: "user_message", content: "导出我" }) +
      line({ type: "tool_call", callId: "c1", tool: "bash", args: { command: "echo hi" } }) +
      line({ type: "tool_result", callId: "c1", ok: true, output: "y".repeat(300) }),
  );
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

describe("3-06 kcode export", () => {
  it("历史会话导出 Markdown，工具输出全文保留", async () => {
    const out = join(cwd, "out.md");
    const lines: string[] = [];
    expect(await exportCommand(cwd, home, ["sess_export", out], (l) => lines.push(l))).toBe(true);
    const md = await readFile(out, "utf8");
    expect(md).toContain("导出我");
    expect(md).toContain("y".repeat(300));
  });

  it(".jsonl 目标原样导出事件", async () => {
    const out = join(cwd, "out.jsonl");
    expect(await exportCommand(cwd, home, ["latest", out], () => undefined)).toBe(true);
    const lines = (await readFile(out, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(4);
    expect((JSON.parse(lines[3]!) as { output: string }).output).toHaveLength(300);
  });
});

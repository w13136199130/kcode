import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KeychainStore, ProviderRouter } from "@kcode/platform";
import type { IPlatformService, SessionEvent } from "@kcode/contracts";
import type { Runtime } from "../src/bootstrap.js";
import { createSession } from "../src/session.js";

let home: string;
let workspace: string;
let savedCwd: string;

const keychain: KeychainStore = {
  async get() {
    return null;
  },
  async set() {},
  async delete() {},
  async list() {
    return [];
  },
};

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-fork-"));
  workspace = await mkdtemp(join(tmpdir(), "kcode-fork-ws-"));
  savedCwd = process.cwd();
  process.chdir(workspace);
});
afterAll(async () => {
  process.chdir(savedCwd);
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

function runtime(): Runtime {
  return {
    models: { providers: {}, default: "test/m" },
    keychain,
    router: { resolve: async () => ({ id: "test:p", stream: async function* () {} }) } as unknown as ProviderRouter,
    platform: {} as IPlatformService,
    kcodeHomeDir: home,
  } as unknown as Runtime;
}

const ev = (e: SessionEvent): string => `${JSON.stringify(e)}\n`;

describe("4-05 fork", () => {
  it("fork 使用新 sessionId 写新 JSONL，源会话保留", async () => {
    const sessionsDir = join(home, "cli", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sourceId = "sess_fork_source";
    await writeFile(
      join(sessionsDir, `${sourceId}.jsonl`),
      ev({ v: 1, type: "session_start", ts: 0, sessionId: sourceId, model: "test/m", cwd: workspace }) +
        ev({ v: 1, type: "user_message", ts: 0, sessionId: sourceId, content: "fork 前的问题" }) +
        ev({ v: 1, type: "assistant_message", ts: 0, sessionId: sourceId, content: "fork 前的回答" }),
      "utf8",
    );

    const forked = await createSession({
      runtime: runtime(),
      model: "test/m",
      cwd: workspace,
      resumeFrom: sourceId,
      fork: true,
    });
    expect(forked.sessionId).not.toBe(sourceId);
    expect(forked.sessionId).toMatch(/^sess_/);
    await forked.close();

    // 源仍在；新文件已创建（session_start 在首次 turn 时落盘，空文件也算新分支）
    const { readFile } = await import("node:fs/promises");
    await expect(readFile(join(sessionsDir, `${sourceId}.jsonl`), "utf8")).resolves.toContain("fork 前的问题");
    await expect(stat(join(sessionsDir, `${forked.sessionId}.jsonl`))).resolves.toBeTruthy();
  }, 30_000);
});

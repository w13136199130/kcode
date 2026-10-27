import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { listSessionIndex, upsertSessionIndex } from "../src/session-index.js";

const homes: string[] = [];
const worker = fileURLToPath(new URL("./fixtures/session-index-upsert.mjs", import.meta.url));

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "kcode-index-lock-"));
  homes.push(home);
  return home;
}

function run(home: string, prefix: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", worker, home, prefix, "100"], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("session-index cross-process lock", () => {
  it("two processes × 100 upserts lose no updates", async () => {
    const home = await tempHome();
    const [a, b] = await Promise.all([run(home, "left"), run(home, "right")]);
    expect([a, b]).toEqual([0, 0]);
    const sessions = await listSessionIndex(home);
    expect(sessions).toHaveLength(200);
    expect(new Set(sessions.map((item) => item.sessionId)).size).toBe(200);
  }, 120_000);

  it("takes over a stale lock whose pid is gone", async () => {
    const home = await tempHome();
    await mkdir(join(home, "desktop"), { recursive: true });
    await writeFile(
      join(home, "desktop", "session-index.json.lock"),
      JSON.stringify({ pid: 999_999, token: "stale", startedAt: Date.now() }),
      "utf8",
    );
    await upsertSessionIndex(home, { sessionId: "sess_after_stale", workspaceKey: "E:/space/a" });
    expect((await listSessionIndex(home)).map((item) => item.sessionId)).toEqual(["sess_after_stale"]);
  });

  it("rejects when a live pid holds the lock past the wait window", async () => {
    const home = await tempHome();
    await mkdir(join(home, "desktop"), { recursive: true });
    await writeFile(
      join(home, "desktop", "session-index.json.lock"),
      JSON.stringify({ pid: process.pid, token: "held", startedAt: Date.now() }),
      "utf8",
    );
    await expect(
      upsertSessionIndex(home, { sessionId: "sess_blocked", workspaceKey: "E:/space/a" }),
    ).rejects.toThrow(/锁等待超时/);
  }, 10_000);
});

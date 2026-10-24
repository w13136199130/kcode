import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listDeletedSessions, clearDeletedSessions, setSessionDeleted } from "../src/session-trash.js";

const homes: string[] = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "kcode-session-trash-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("session-trash", () => {
  it("soft deletes and restores", async () => {
    const home = await tempHome();
    await setSessionDeleted(home, "sess_a", true);
    expect([...(await listDeletedSessions(home))]).toEqual(["sess_a"]);
    await setSessionDeleted(home, "sess_a", false);
    expect(await listDeletedSessions(home)).toEqual(new Set());
  });

  it("clears all trash entries", async () => {
    const home = await tempHome();
    await setSessionDeleted(home, "sess_a", true);
    await setSessionDeleted(home, "sess_b", true);
    expect((await clearDeletedSessions(home)).sort()).toEqual(["sess_a", "sess_b"]);
    expect(await listDeletedSessions(home)).toEqual(new Set());
  });
});

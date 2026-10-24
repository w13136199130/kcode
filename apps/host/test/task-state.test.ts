import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listArchived, setArchived } from "../src/task-state.js";

const homes: string[] = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "kcode-task-state-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("task-state", () => {
  it("archives and unarchives sessions without touching files", async () => {
    const home = await tempHome();
    await setArchived(home, "sess_a", true);
    await setArchived(home, "sess_b", true);
    expect([...(await listArchived(home))].sort()).toEqual(["sess_a", "sess_b"]);
    await setArchived(home, "sess_a", false);
    expect([...(await listArchived(home))]).toEqual(["sess_b"]);
  });

  it("returns empty state for corrupt JSON", async () => {
    const home = await tempHome();
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(home, "desktop"), { recursive: true });
    await writeFile(join(home, "desktop", "task-state.json"), "{bad", "utf8");
    expect(await listArchived(home)).toEqual(new Set());
  });
});

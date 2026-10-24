import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addWorkspace, listWorkspaces, removeWorkspace } from "../src/workspace-store.js";

const homes: string[] = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "kcode-workspace-store-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("workspace-store", () => {
  it("adds, dedupes and lists workspaces", async () => {
    const home = await tempHome();
    const first = await addWorkspace(home, "C:\\work\\kcode");
    const second = await addWorkspace(home, "C:\\work\\kcode\\");
    expect(first.path).toBe("C:\\work\\kcode");
    expect(second.createdAt).toBe(first.createdAt);
    const list = await listWorkspaces(home);
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("kcode");
  });

  it("removes by normalized path without touching other entries", async () => {
    const home = await tempHome();
    await addWorkspace(home, "C:\\work\\a");
    await addWorkspace(home, "C:\\work\\b");
    expect(await removeWorkspace(home, "C:/work/a/")).toBe(true);
    expect((await listWorkspaces(home)).map((item) => item.name)).toEqual(["b"]);
  });

  it("returns empty list for a corrupt store", async () => {
    const home = await tempHome();
    await mkdir(join(home, "desktop"), { recursive: true });
    await writeFile(join(home, "desktop", "projects.json"), "{oops", "utf8");
    expect(await listWorkspaces(home)).toEqual([]);
  });
});

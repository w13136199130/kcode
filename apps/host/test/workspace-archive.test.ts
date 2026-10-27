import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorkspace, listWorkspaces, setWorkspaceArchived } from "../src/workspace-store.js";

/** S1-1（F5）：归档工作区——注册表标记的置位/复位/未知路径。 */
describe("workspace archive（S1-1）", () => {
  it("归档 → 列表带标记 → 取消归档 → 标记移除；未知路径返回 null", async () => {
    const home = await mkdtemp(join(tmpdir(), "kcode-ws-archive-"));
    await addWorkspace(home, "E:/proj/alpha");
    await addWorkspace(home, "E:/proj/beta");

    const archived = await setWorkspaceArchived(home, "E:/proj/alpha/", true);
    expect(archived?.archived).toBe(true);

    let list = await listWorkspaces(home);
    expect(list.find((w) => w.name === "alpha")?.archived).toBe(true);
    expect(list.find((w) => w.name === "beta")?.archived).toBeUndefined();

    const restored = await setWorkspaceArchived(home, "E:/proj/alpha", false);
    expect(restored?.archived).toBeUndefined();
    list = await listWorkspaces(home);
    expect(list.find((w) => w.name === "alpha")?.archived).toBeUndefined();

    await expect(setWorkspaceArchived(home, "E:/proj/missing", true)).rejects.toThrow("工作区不存在");
  });
});

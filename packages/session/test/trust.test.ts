import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isProjectTrusted, trustProject } from "../src/index.js";

/** N3I-4：信任状态读取——已信任项目 /trust 从菜单隐藏的数据源 */

let home: string;
let workspace: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-trust-"));
  workspace = await mkdtemp(join(tmpdir(), "kcode-trust-ws-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

describe("isProjectTrusted", () => {
  it("未信任 false → trustProject 落盘 → true（幂等）", async () => {
    await expect(isProjectTrusted(workspace, home)).resolves.toBe(false);
    await trustProject(workspace, home);
    await expect(isProjectTrusted(workspace, home)).resolves.toBe(true);
    await trustProject(workspace, home);
    await expect(isProjectTrusted(workspace, home)).resolves.toBe(true);
  });

  it("清单文件缺失按未信任处理", async () => {
    await expect(isProjectTrusted(workspace, join(home, "nope"))).resolves.toBe(false);
  });

  it("win32 大小写/分隔符差异视为同一项目（信任持久化匹配）", async () => {
    await trustProject(workspace, home);
    const alt = workspace.replace(/\\/g, "/");
    const flipped = process.platform === "win32" ? alt.toLocaleLowerCase() : alt;
    await expect(isProjectTrusted(flipped, home)).resolves.toBe(true);
  });
});

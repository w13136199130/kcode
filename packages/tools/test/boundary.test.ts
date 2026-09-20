import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { editTool, writeTool } from "../src/index.js";

let root: string;
let ws: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-boundary-"));
  ws = join(root, "workspace");
  await mkdir(ws, { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 工作区边界（沙箱 v1）：写/编辑工具对越界路径返回告警，由权限确认兜底 */
describe("工作区边界检查", () => {
  it("工作区内正常写入", async () => {
    const result = await writeTool.execute(
      { path: "ok.txt", content: "内容" },
      { sessionId: "s", cwd: ws },
    );
    expect(result.ok).toBe(true);
  });

  it("工作区外写入返回告警", async () => {
    const result = await writeTool.execute(
      { path: join(root, "outside.txt"), content: "越界" },
      { sessionId: "s", cwd: ws },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("之外");
  });

  it("工作区外编辑返回告警；工作区内正常编辑", async () => {
    await writeFile(join(ws, "edit.txt"), "内容\n", "utf8");
    const inside = await editTool.execute(
      { path: "edit.txt", oldString: "内容", newString: "改后" },
      { sessionId: "s", cwd: ws },
    );
    expect(inside.ok).toBe(true);

    const outside = await editTool.execute(
      { path: join(root, "edit-outside.txt"), oldString: "内容", newString: "改" },
      { sessionId: "s", cwd: ws },
    );
    expect(outside.ok).toBe(false);
    expect(outside.error).toContain("之外");
  });

  it("无 cwd 时不做边界检查（兼容无工作区场景）", async () => {
    const result = await writeTool.execute(
      { path: join(root, "no-cwd.txt"), content: "无工作区" },
      { sessionId: "s" },
    );
    expect(result.ok).toBe(true);
  });
});

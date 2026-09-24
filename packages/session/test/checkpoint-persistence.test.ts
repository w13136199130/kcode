import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CheckpointStore } from "../src/checkpoints.js";

let root: string;
let dir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-checkpoint-"));
  dir = join(root, "checkpoints", "sess_test");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("检查点持久化", () => {
  it("清单落盘后重开目录仍可列出并恢复检查点", async () => {
    const target = join(root, "keep.txt");
    await writeFile(target, "原始内容", "utf8");

    const store = await CheckpointStore.open(dir);
    await store.snapshot("call_a", target);
    // 不存在文件的前像：回退语义为删除
    await store.snapshot("call_b", join(root, "ghost.txt"));

    // 模拟重启：用同一目录重新打开，装载既有清单
    const reopened = await CheckpointStore.open(dir);
    const entries = reopened.list();
    expect(entries).toHaveLength(2);
    expect(reopened.get("call_a")).toMatchObject({ callId: "call_a", path: target, existed: true });
    expect(reopened.get("call_b")).toMatchObject({ existed: false });

    // 外部改动后回退：恢复原始前像
    await writeFile(target, "被改写的内容", "utf8");
    const restored = await reopened.restore(["call_a"]);
    expect(restored).toBe(1);
    expect(await readFile(target, "utf8")).toBe("原始内容");
  });

  it("目录无清单时按空目录打开，不抛错", async () => {
    const fresh = await CheckpointStore.open(join(root, "checkpoints", "sess_fresh"));
    expect(fresh.list()).toHaveLength(0);
  });

  it("重开后继续快照不会与既有前像重名", async () => {
    const d = join(root, "checkpoints", "sess_append");
    const target = join(root, "second.txt");
    await writeFile(target, "v1", "utf8");

    const store = await CheckpointStore.open(d);
    await store.snapshot("call_1", target);
    await store.snapshot("call_2", target);

    const reopened = await CheckpointStore.open(d);
    await reopened.snapshot("call_3", target);
    expect(reopened.list()).toHaveLength(3);
    // 第三条前像的落盘文件名基于重载后的条目数（2），不与 0/1 重名
    expect(reopened.get("call_3")?.snapshotPath).toContain("2-");
  });
});

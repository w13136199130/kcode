import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupStorage, removeSessionData, sessionDataPaths } from "../src/index.js";

/** 3-30：保留策略（会话年龄/数量、孤儿产物、总量配额、rm 级联） */
let home: string;
const DAY = 24 * 60 * 60 * 1000;

async function writeSession(id: string, ageDays = 0): Promise<string> {
  const dir = join(home, "cli", "sessions");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  await writeFile(path, `${JSON.stringify({ v: 1, type: "session_start", ts: 0, sessionId: id, model: "m" })}\n`);
  const at = new Date(Date.now() - ageDays * DAY);
  await utimes(path, at, at);
  return path;
}

async function touch(path: string, bytes = 10): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "x".repeat(bytes));
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-retention-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("cleanupStorage", () => {
  it("dry-run 只计划；apply 删除过期会话、孤儿产物、过期子代理", async () => {
    await writeSession("sess_keep");
    await writeSession("sess_old", 40);
    await touch(join(home, "cli", "artifacts", "sess_old", "a.bin"));
    await touch(join(home, "cli", "artifacts", "checkpoints", "sess_old", "cp.bin"));
    await touch(join(home, "cli", "audit", "sess_old.jsonl"));
    await touch(join(home, "cli", "artifacts", "orphan", "o.bin"));
    await touch(join(home, "cli", "audit", "orphan.jsonl"));
    await touch(join(home, "cli", "sessions", "subagents", "sub_old.jsonl"));
    const sub = join(home, "cli", "sessions", "subagents", "sub_old.jsonl");
    const old = new Date(Date.now() - 40 * DAY);
    await utimes(sub, old, old);

    const dry = await cleanupStorage(home, { maxSessions: 10, maxAgeDays: 30, dryRun: true });
    expect(dry.deletedSessions).toContain("sess_old");
    expect(dry.freedBytes).toBeGreaterThan(0);
    expect(existsSync(join(home, "cli", "sessions", "sess_old.jsonl"))).toBe(true);

    const applied = await cleanupStorage(home, { maxSessions: 10, maxAgeDays: 30 });
    expect(applied.deletedSessions).toContain("sess_old");
    expect(existsSync(join(home, "cli", "sessions", "sess_old.jsonl"))).toBe(false);
    expect(existsSync(join(home, "cli", "artifacts", "sess_old"))).toBe(false);
    expect(existsSync(join(home, "cli", "artifacts", "checkpoints", "sess_old"))).toBe(false);
    expect(existsSync(join(home, "cli", "audit", "sess_old.jsonl"))).toBe(false);
    expect(existsSync(join(home, "cli", "artifacts", "orphan"))).toBe(false);
    expect(existsSync(join(home, "cli", "sessions", "subagents", "sub_old.jsonl"))).toBe(false);
    expect(existsSync(join(home, "cli", "sessions", "sess_keep.jsonl"))).toBe(true);
  });

  it("数量上限：超出 maxSessions 的旧会话被清理；产物体积超限淘汰最旧", async () => {
    await writeSession("sess_a", 2);
    await writeSession("sess_b", 1);
    await writeSession("sess_c", 0);
    await touch(join(home, "cli", "artifacts", "sess_a", "a.bin"), 800);
    await touch(join(home, "cli", "artifacts", "sess_b", "b.bin"), 800);
    await touch(join(home, "cli", "artifacts", "sess_c", "c.bin"), 800);

    const applied = await cleanupStorage(home, {
      maxSessions: 1,
      maxAgeDays: 30,
      maxArtifactBytes: 1_000,
    });
    expect(applied.deletedSessions).toContain("sess_a");
    expect(applied.deletedSessions).toContain("sess_b");
    expect(existsSync(join(home, "cli", "sessions", "sess_c.jsonl"))).toBe(true);
    expect(existsSync(join(home, "cli", "artifacts", "sess_c"))).toBe(true);
  });

  it("审计总量超限：从最旧审计文件开始淘汰", async () => {
    await writeSession("audit_old");
    await writeSession("audit_new");
    const auditDir = join(home, "cli", "audit");
    await touch(join(auditDir, "audit_old.jsonl"), 400);
    await touch(join(auditDir, "audit_new.jsonl"), 400);
    const old = new Date(Date.now() - 2 * DAY);
    await utimes(join(auditDir, "audit_old.jsonl"), old, old);
    await cleanupStorage(home, { maxAuditBytes: 500, maxSessions: 100, maxAgeDays: 365 });
    expect(existsSync(join(auditDir, "audit_old.jsonl"))).toBe(false);
    expect(existsSync(join(auditDir, "audit_new.jsonl"))).toBe(true);
  });
});

describe("removeSessionData", () => {
  it("rm 级联路径覆盖会话/产物/检查点/审计", async () => {
    await writeSession("sess_rm");
    await touch(join(home, "cli", "sessions", "sess_rm.title"));
    await touch(join(home, "cli", "artifacts", "sess_rm", "x.bin"));
    await touch(join(home, "cli", "artifacts", "checkpoints", "sess_rm", "cp.bin"));
    await touch(join(home, "cli", "audit", "sess_rm.jsonl"));
    for (const path of sessionDataPaths(home, "sess_rm")) {
      expect(existsSync(path)).toBe(true);
    }
    const freed = await removeSessionData(home, "sess_rm");
    expect(freed).toBeGreaterThan(0);
    for (const path of sessionDataPaths(home, "sess_rm")) {
      expect(existsSync(path)).toBe(false);
    }
  });
});

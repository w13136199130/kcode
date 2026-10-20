import { lstat, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * 3-30：会话/产物/检查点/审计的保留策略。
 * 配额与清理都集中在这里（CLI `kcode sessions vacuum` 与 `rm` 级联共用）：
 * - 会话：按年龄 + 数量保留最新；
 * - 产物/检查点/审计：孤儿（会话已删）直接清理；总量超预算时从最旧会话开始淘汰；
 * - 子代理会话：按年龄清理（文件名不带父会话 id，无法精确归属）。
 * dryRun 只返回计划，不落删。
 */

export interface RetentionOptions {
  maxSessions: number;
  maxAgeDays: number;
  maxArtifactBytes: number;
  maxAuditBytes: number;
  dryRun?: boolean;
}

export interface RetentionResult {
  dryRun: boolean;
  deletedSessions: string[];
  deletedPaths: string[];
  freedBytes: number;
  keptSessions: number;
  artifactBytes: number;
  auditBytes: number;
}

const DEFAULTS: Omit<RetentionOptions, "dryRun"> = {
  maxSessions: 200,
  maxAgeDays: 30,
  maxArtifactBytes: 1024 * 1024 * 1024, // 1 GiB
  maxAuditBytes: 100 * 1024 * 1024, // 100 MiB
};

export function defaultRetentionOptions(): RetentionOptions {
  return { ...DEFAULTS };
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

async function pathSize(path: string): Promise<number> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return 0;
    if (!info.isDirectory()) return info.size;
    let total = 0;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      total += await pathSize(join(path, entry.name));
    }
    return total;
  } catch {
    return 0;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 会话相关派生数据的路径集合（rm 级联 / vacuum 共用） */
export function sessionDataPaths(kcodeHomeDir: string, sessionId: string): string[] {
  return [
    join(kcodeHomeDir, "cli", "sessions", `${sessionId}.jsonl`),
    join(kcodeHomeDir, "cli", "sessions", `${sessionId}.title`),
    join(kcodeHomeDir, "cli", "artifacts", sessionId),
    join(kcodeHomeDir, "cli", "artifacts", "checkpoints", sessionId),
    join(kcodeHomeDir, "cli", "audit", `${sessionId}.jsonl`),
  ];
}

/** 删除会话的派生数据（会话文件由 deleteSession 负责；此函数清理产物/检查点/审计） */
export async function removeSessionData(kcodeHomeDir: string, sessionId: string): Promise<number> {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error("会话 id 不合法");
  }
  let freed = 0;
  for (const path of sessionDataPaths(kcodeHomeDir, sessionId)) {
    freed += await pathSize(path);
    await rm(path, { recursive: true, force: true });
  }
  return freed;
}

/** 执行保留策略；默认 dryRun=false（CLI 可显式 --dry-run） */
export async function cleanupStorage(
  kcodeHomeDir: string,
  options: Partial<RetentionOptions> = {},
): Promise<RetentionResult> {
  const opts: RetentionOptions = { ...DEFAULTS, ...options };
  const sessionsDir = join(kcodeHomeDir, "cli", "sessions");
  const artifactsDir = join(kcodeHomeDir, "cli", "artifacts");
  const checkpointsDir = join(artifactsDir, "checkpoints");
  const auditDir = join(kcodeHomeDir, "cli", "audit");
  const subagentsDir = join(sessionsDir, "subagents");
  const cutoff = Date.now() - opts.maxAgeDays * 24 * 60 * 60 * 1000;

  const sessionFiles = (await readdir(sessionsDir).catch(() => []))
    .filter((name) => name.endsWith(".jsonl") && SESSION_ID_RE.test(name.slice(0, -6)))
    .map((name) => ({ sessionId: name.slice(0, -6), path: join(sessionsDir, name) }))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));

  const sessions = await Promise.all(
    sessionFiles.map(async (s) => ({ ...s, mtimeMs: (await stat(s.path).catch(() => null))?.mtimeMs ?? 0 })),
  );
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = new Set<string>();
  const deleteSessions = new Set<string>();
  sessions.forEach((s, index) => {
    if (s.mtimeMs < cutoff || index >= opts.maxSessions) {
      deleteSessions.add(s.sessionId);
    } else {
      keep.add(s.sessionId);
    }
  });

  // 孤儿：产物/检查点/审计目录中已无会话文件的条目
  const orphanCandidates: string[] = [];
  for (const [root, suffix] of [
    [artifactsDir, ""],
    [checkpointsDir, ""],
    [auditDir, ".jsonl"],
  ] as const) {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === "checkpoints") continue;
      const id = suffix === "" ? entry.name : entry.name.endsWith(suffix) ? entry.name.slice(0, -suffix.length) : null;
      if (id === null || !SESSION_ID_RE.test(id)) continue;
      if (!keep.has(id) && !deleteSessions.has(id)) orphanCandidates.push(join(root, entry.name));
    }
  }

  // 产物总量：只统计最终保留的会话（待删/孤儿会在下面释放），超预算时最旧先淘汰
  const keepArtifacts = new Map<string, { dir: string; checkpoint: string; bytes: number; mtimeMs: number }>();
  for (const id of keep) {
    const dir = join(artifactsDir, id);
    const checkpoint = join(checkpointsDir, id);
    const bytes = (await pathSize(dir)) + (await pathSize(checkpoint));
    const info = await stat(dir).catch(() => null);
    if (bytes > 0) keepArtifacts.set(id, { dir, checkpoint, bytes, mtimeMs: info?.mtimeMs ?? 0 });
  }
  let artifactBytes = [...keepArtifacts.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  const evictedArtifacts: string[] = [];
  for (const [id, entry] of [...keepArtifacts.entries()].sort((a, b) => a[1].mtimeMs - b[1].mtimeMs)) {
    if (artifactBytes <= opts.maxArtifactBytes) break;
    artifactBytes -= entry.bytes;
    keep.delete(id);
    evictedArtifacts.push(entry.dir, entry.checkpoint);
  }

  // 审计总量：只统计最终保留的会话，超预算从最旧开始淘汰
  const auditEntries: { path: string; bytes: number; mtimeMs: number }[] = [];
  for (const entry of await readdir(auditDir).catch(() => [])) {
    if (!entry.endsWith(".jsonl")) continue;
    const id = entry.slice(0, -".jsonl".length);
    if (!keep.has(id)) continue;
    const path = join(auditDir, entry);
    const info = await stat(path).catch(() => null);
    if (info !== null) auditEntries.push({ path, bytes: info.size, mtimeMs: info.mtimeMs });
  }
  auditEntries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let auditBytes = auditEntries.reduce((sum, entry) => sum + entry.bytes, 0);
  const evictedAudit: string[] = [];
  for (const entry of auditEntries) {
    if (auditBytes <= opts.maxAuditBytes) break;
    auditBytes -= entry.bytes;
    evictedAudit.push(entry.path);
  }

  // 子代理会话：按年龄清理（无父会话映射）
  const staleSubagents: string[] = [];
  for (const entry of await readdir(subagentsDir).catch(() => [])) {
    if (!entry.endsWith(".jsonl")) continue;
    const path = join(subagentsDir, entry);
    const info = await stat(path).catch(() => null);
    if (info !== null && info.mtimeMs < cutoff) staleSubagents.push(path);
  }

  const deletePaths: string[] = [];
  let freedBytes = 0;
  const deletedSessions = [...deleteSessions];
  for (const sessionId of deletedSessions) {
    for (const path of sessionDataPaths(kcodeHomeDir, sessionId)) {
      if (await exists(path)) {
        freedBytes += await pathSize(path);
        deletePaths.push(path);
      }
    }
  }
  for (const path of [...orphanCandidates, ...evictedArtifacts, ...evictedAudit, ...staleSubagents]) {
    if (!deletePaths.includes(path)) {
      freedBytes += await pathSize(path);
      deletePaths.push(path);
    }
  }

  if (opts.dryRun !== true) {
    for (const path of deletePaths) {
      await rm(path, { recursive: true, force: true });
    }
    // 清理后复算总量，结果用于展示
    artifactBytes = 0;
    for (const entry of await readdir(artifactsDir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === "checkpoints") continue;
      if (entry.isDirectory()) artifactBytes += await pathSize(join(artifactsDir, entry.name));
    }
    auditBytes = 0;
    for (const entry of await readdir(auditDir).catch(() => [])) {
      const info = await stat(join(auditDir, entry)).catch(() => null);
      if (info?.isFile() === true) auditBytes += info.size;
    }
  }

  return {
    dryRun: opts.dryRun === true,
    deletedSessions,
    deletedPaths: deletePaths,
    freedBytes,
    keptSessions: keep.size,
    artifactBytes,
    auditBytes,
  };
}

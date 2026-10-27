import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * 桌面会话索引（Phase 1）。
 *
 * 只保存“会话元数据/归属”，消息仍在 JSONL；索引是可重建的缓存 + 空会话占位。
 * 所有写入同进程串行 + 跨进程 lock 文件 + 临时文件 rename，避免半截 JSON/丢更新。
 */
export interface SessionIndexEntry {
  sessionId: string;
  workspaceKey: string;
  createdAt: number;
  updatedAt: number;
  preview?: string;
  title?: string;
  status?: "draft" | "active" | "failed";
  requestId?: string;
  ungrouped?: boolean;
}

interface IndexFile {
  version: 1;
  sessions: SessionIndexEntry[];
}

const FILE = "desktop/session-index.json";
const MAX_ENTRIES = 500;
/** 创建中断留下的 draft/failed 超过一天仍未落盘，视为 stale。 */
const STALE_DRAFT_MS = 24 * 60 * 60_000;
// 存活持有者的等待窗口（须 < LOCK_STALE_MS，否则先触发 stale 接管语义）；KCODE_INDEX_LOCK_WAIT_MS 可调
const LOCK_WAIT_MS = Number(process.env["KCODE_INDEX_LOCK_WAIT_MS"] ?? "2000");
const LOCK_STALE_MS = 5_000;

function indexPath(kcodeHomeDir: string): string {
  return join(kcodeHomeDir, FILE);
}

async function readIndex(kcodeHomeDir: string): Promise<SessionIndexEntry[]> {
  try {
    const raw = JSON.parse(await readFile(indexPath(kcodeHomeDir), "utf8")) as Partial<IndexFile>;
    if (raw.version !== 1 || !Array.isArray(raw.sessions)) return [];
    return raw.sessions.filter(
      (item): item is SessionIndexEntry =>
        typeof item === "object" &&
        item !== null &&
        typeof item.sessionId === "string" &&
        item.sessionId !== "" &&
        typeof item.workspaceKey === "string" &&
        typeof item.createdAt === "number" &&
        typeof item.updatedAt === "number",
    );
  } catch {
    return [];
  }
}

async function writeIndex(kcodeHomeDir: string, sessions: SessionIndexEntry[]): Promise<void> {
  const path = indexPath(kcodeHomeDir);
  await mkdir(dirname(path), { recursive: true });
  const trimmed = [...sessions]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ENTRIES);
  const tmp = `${path}.${process.pid}.tmp`;
  const body = `${JSON.stringify({ version: 1, sessions: trimmed } satisfies IndexFile, null, 2)}\n`;
  await writeFile(tmp, body, "utf8");
  // Windows Defender 对新写文件的扫描锁可让"替换已有文件"的 rename 报 EPERM（本仓库已两遇）：
  // 短重试后降级直写——读取侧（readIndex）对损坏文件本就安全降级，并由下一次写入自愈。
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EPERM" || attempt >= 2) {
        await writeFile(path, body, "utf8");
        return;
      }
      await sleep(80 * (attempt + 1));
    }
  }
}

let queue: Promise<unknown> = Promise.resolve();

function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

function lockPath(kcodeHomeDir: string): string {
  return `${indexPath(kcodeHomeDir)}.lock`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireLock(kcodeHomeDir: string): Promise<string> {
  const path = lockPath(kcodeHomeDir);
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }), "utf8");
      } finally {
        await handle.close();
      }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const raw = JSON.parse(await readFile(path, "utf8")) as {
          pid?: unknown;
          startedAt?: unknown;
        };
        const pid = typeof raw.pid === "number" ? raw.pid : 0;
        const startedAt = typeof raw.startedAt === "number" ? raw.startedAt : 0;
        stale = !pidAlive(pid) || Date.now() - startedAt > LOCK_STALE_MS;
      } catch {
        // 锁文件正在被写入或已损坏：按超时继续等待；过期后仍可被清理。
        stale = false;
      }
      if (stale) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) throw new Error("session-index 锁等待超时（2s）");
      await sleep(20);
    }
  }
}

async function withIndexLock<T>(kcodeHomeDir: string, task: () => Promise<T>): Promise<T> {
  await mkdir(dirname(indexPath(kcodeHomeDir)), { recursive: true });
  const token = await acquireLock(kcodeHomeDir);
  try {
    return await task();
  } finally {
    try {
      const raw = JSON.parse(await readFile(lockPath(kcodeHomeDir), "utf8")) as { token?: unknown };
      if (raw.token === token) await unlink(lockPath(kcodeHomeDir)).catch(() => undefined);
    } catch {
      // 锁已被清理/替换：不误删别人的锁。
    }
  }
}

export async function listSessionIndex(kcodeHomeDir: string): Promise<SessionIndexEntry[]> {
  return readIndex(kcodeHomeDir);
}

export async function findSessionIndexByRequest(
  kcodeHomeDir: string,
  requestId: string,
): Promise<SessionIndexEntry | undefined> {
  if (requestId === "") return undefined;
  return (await readIndex(kcodeHomeDir)).find((item) => item.requestId === requestId);
}

/** 用真实 JSONL 摘要回填索引；空会话/尚未落盘的会话保持原样。 */
export async function reconcileSessionIndex(
  kcodeHomeDir: string,
  summaries: Array<{
    sessionId: string;
    workspaceKey: string;
    modifiedAt: number;
    preview: string;
    title?: string;
  }>,
): Promise<void> {
  await serial(() =>
    withIndexLock(kcodeHomeDir, async () => {
      const sessions = await readIndex(kcodeHomeDir);
      const byId = new Map(summaries.map((summary) => [summary.sessionId, summary]));
    let changed = false;
    const next = sessions.map((item) => {
      const actual = byId.get(item.sessionId);
      if (actual === undefined) return item;
      const workspaceKey = actual.workspaceKey !== "" ? actual.workspaceKey : item.workspaceKey;
      const preview = actual.preview !== "" ? actual.preview : item.preview;
      const title = actual.title ?? item.title;
      const updatedAt = actual.modifiedAt;
      if (
        workspaceKey === item.workspaceKey &&
        preview === item.preview &&
        title === item.title &&
        updatedAt === item.updatedAt &&
        item.status === "active"
      ) {
        return item;
      }
      changed = true;
      return {
        ...item,
        workspaceKey,
        updatedAt,
        status: "active" as const,
        ...(preview !== undefined ? { preview } : {}),
        ...(title !== undefined ? { title } : {}),
      };
    });
    // 迁移：有 workspaceKey 的历史会话补进索引；无 key 的保持“任务”，不猜归属。
    const indexedIds = new Set(next.map((item) => item.sessionId));
    for (const actual of summaries) {
      if (actual.workspaceKey === "" || indexedIds.has(actual.sessionId)) continue;
      next.push({
        sessionId: actual.sessionId,
        workspaceKey: actual.workspaceKey,
        createdAt: actual.modifiedAt,
        updatedAt: actual.modifiedAt,
        status: "active",
        ...(actual.preview !== "" ? { preview: actual.preview } : {}),
        ...(actual.title !== undefined ? { title: actual.title } : {}),
      });
      changed = true;
    }
    const cutoff = Date.now() - STALE_DRAFT_MS;
    const cleaned = next.filter((item) => {
      if (item.status !== "draft" && item.status !== "failed") return true;
      if (byId.has(item.sessionId)) return true;
      if (item.updatedAt >= cutoff) return true;
      changed = true;
      return false;
    });
    if (changed) await writeIndex(kcodeHomeDir, cleaned);
    }),
  );
}

export async function patchSessionIndex(
  kcodeHomeDir: string,
  sessionId: string,
  patch: Partial<Pick<SessionIndexEntry, "preview" | "title">>,
): Promise<void> {
  await serial(() =>
    withIndexLock(kcodeHomeDir, async () => {
      const sessions = await readIndex(kcodeHomeDir);
      const current = sessions.find((item) => item.sessionId === sessionId);
      if (current === undefined) return;
      const next = {
        ...current,
        ...(patch.preview !== undefined ? { preview: patch.preview } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        updatedAt: Date.now(),
      };
      await writeIndex(kcodeHomeDir, [...sessions.filter((item) => item.sessionId !== sessionId), next]);
    }),
  );
}

export async function removeSessionIndex(kcodeHomeDir: string, sessionId: string): Promise<void> {
  await serial(() =>
    withIndexLock(kcodeHomeDir, async () => {
      const sessions = await readIndex(kcodeHomeDir);
      if (!sessions.some((item) => item.sessionId === sessionId)) return;
      await writeIndex(kcodeHomeDir, sessions.filter((item) => item.sessionId !== sessionId));
    }),
  );
}

export async function upsertSessionIndex(
  kcodeHomeDir: string,
  entry: Omit<SessionIndexEntry, "createdAt" | "updatedAt"> & { createdAt?: number; updatedAt?: number },
): Promise<void> {
  if (entry.sessionId.trim() === "" || entry.workspaceKey.trim() === "") return;
  await serial(() =>
    withIndexLock(kcodeHomeDir, async () => {
      const sessions = await readIndex(kcodeHomeDir);
      const now = Date.now();
      const previous = sessions.find((item) => item.sessionId === entry.sessionId);
      const next: SessionIndexEntry = {
        sessionId: entry.sessionId,
        workspaceKey: entry.workspaceKey,
        createdAt: previous?.createdAt ?? entry.createdAt ?? now,
        updatedAt: entry.updatedAt ?? now,
        ...(entry.preview ?? previous?.preview ? { preview: entry.preview ?? previous?.preview } : {}),
        ...(entry.title ?? previous?.title ? { title: entry.title ?? previous?.title } : {}),
        ...(entry.status ?? previous?.status ? { status: entry.status ?? previous?.status } : {}),
        ...(entry.requestId ?? previous?.requestId ? { requestId: entry.requestId ?? previous?.requestId } : {}),
        ...(entry.ungrouped === true || previous?.ungrouped === true ? { ungrouped: true } : {}),
      };
      await writeIndex(kcodeHomeDir, [...sessions.filter((item) => item.sessionId !== entry.sessionId), next]);
    }),
  );
}

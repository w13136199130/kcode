import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * 桌面会话索引（Phase 1）。
 *
 * 只保存“会话元数据/归属”，消息仍在 JSONL；索引是可重建的缓存 + 空会话占位。
 * 所有写入同进程串行 + 临时文件 rename，避免半截 JSON。
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
}

interface IndexFile {
  version: 1;
  sessions: SessionIndexEntry[];
}

const FILE = "desktop/session-index.json";
const MAX_ENTRIES = 500;
/** 创建中断留下的 draft/failed 超过一天仍未落盘，视为 stale。 */
const STALE_DRAFT_MS = 24 * 60 * 60_000;

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
  await writeFile(tmp, `${JSON.stringify({ version: 1, sessions: trimmed } satisfies IndexFile, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

let queue: Promise<unknown> = Promise.resolve();

function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
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
  await serial(async () => {
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
  });
}

export async function patchSessionIndex(
  kcodeHomeDir: string,
  sessionId: string,
  patch: Partial<Pick<SessionIndexEntry, "preview" | "title">>,
): Promise<void> {
  await serial(async () => {
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
  });
}

export async function removeSessionIndex(kcodeHomeDir: string, sessionId: string): Promise<void> {
  await serial(async () => {
    const sessions = await readIndex(kcodeHomeDir);
    if (!sessions.some((item) => item.sessionId === sessionId)) return;
    await writeIndex(kcodeHomeDir, sessions.filter((item) => item.sessionId !== sessionId));
  });
}

export async function upsertSessionIndex(
  kcodeHomeDir: string,
  entry: Omit<SessionIndexEntry, "createdAt" | "updatedAt"> & { createdAt?: number; updatedAt?: number },
): Promise<void> {
  if (entry.sessionId.trim() === "" || entry.workspaceKey.trim() === "") return;
  await serial(async () => {
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
    };
    await writeIndex(kcodeHomeDir, [...sessions.filter((item) => item.sessionId !== entry.sessionId), next]);
  });
}

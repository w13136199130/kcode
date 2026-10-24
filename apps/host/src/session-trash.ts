import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 软删除状态：只记录 deletedAt，不删除会话 JSONL。 */
interface TrashFile {
  version: 1;
  deleted: Record<string, number>;
}

const FILE = "desktop/session-trash.json";
let queue: Promise<unknown> = Promise.resolve();

function path(home: string): string {
  return join(home, FILE);
}

async function read(home: string): Promise<Record<string, number>> {
  try {
    const raw = JSON.parse(await readFile(path(home), "utf8")) as Partial<TrashFile>;
    if (raw.version !== 1 || typeof raw.deleted !== "object" || raw.deleted === null) return {};
    return Object.fromEntries(
      Object.entries(raw.deleted).filter(
        ([id, at]) => id !== "" && typeof at === "number" && Number.isFinite(at),
      ),
    );
  } catch {
    return {};
  }
}

async function write(home: string, deleted: Record<string, number>): Promise<void> {
  const target = path(home);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, deleted } satisfies TrashFile, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

export async function listDeletedSessions(home: string): Promise<Set<string>> {
  return new Set(Object.keys(await read(home)));
}

export async function setSessionDeleted(home: string, sessionId: string, deleted: boolean): Promise<void> {
  if (sessionId.trim() === "") throw new Error("会话 id 不能为空");
  await serial(async () => {
    const state = await read(home);
    if (deleted) state[sessionId] = Date.now();
    else delete state[sessionId];
    await write(home, state);
  });
}

export async function clearDeletedSessions(home: string): Promise<string[]> {
  return serial(async () => {
    const state = await read(home);
    const ids = Object.keys(state);
    if (ids.length > 0) await write(home, {});
    return ids;
  });
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * 任务归档状态（D3-Host-02）。
 * 只保存 sessionId → archivedAt，不移动/删除会话文件。
 */
interface TaskStateFile {
  version: 1;
  archived: Record<string, number>;
}

const FILE = "desktop/task-state.json";

function statePath(kcodeHomeDir: string): string {
  return join(kcodeHomeDir, FILE);
}

async function readState(kcodeHomeDir: string): Promise<Record<string, number>> {
  try {
    const raw = JSON.parse(await readFile(statePath(kcodeHomeDir), "utf8")) as Partial<TaskStateFile>;
    if (raw.version !== 1 || typeof raw.archived !== "object" || raw.archived === null) return {};
    return Object.fromEntries(
      Object.entries(raw.archived).filter(
        ([id, at]) => id !== "" && typeof at === "number" && Number.isFinite(at),
      ),
    );
  } catch {
    return {};
  }
}

async function writeState(kcodeHomeDir: string, archived: Record<string, number>): Promise<void> {
  const path = statePath(kcodeHomeDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ version: 1, archived } satisfies TaskStateFile, null, 2)}\n`, "utf8");
}

export async function listArchived(kcodeHomeDir: string): Promise<Set<string>> {
  return new Set(Object.keys(await readState(kcodeHomeDir)));
}

export async function setArchived(
  kcodeHomeDir: string,
  sessionId: string,
  archived: boolean,
): Promise<void> {
  if (sessionId.trim() === "") throw new Error("会话 id 不能为空");
  const state = await readState(kcodeHomeDir);
  if (archived) state[sessionId] = Date.now();
  else delete state[sessionId];
  await writeState(kcodeHomeDir, state);
}

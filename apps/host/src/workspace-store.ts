import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { workspaceKey } from "@kcode/shared";

/**
 * 桌面工作区注册表（D3-Host-01）。
 *
 * 只保存“用户显式添加过的工作区”，不复制会话、不删除目录；
 * trust 状态仍由 @kcode/session 的 trusted-projects.json 管理。
 */
export interface WorkspaceRecord {
  path: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

interface StoreFile {
  version: 1;
  workspaces: WorkspaceRecord[];
}

const FILE = "desktop/projects.json";

function storePath(kcodeHomeDir: string): string {
  return join(kcodeHomeDir, FILE);
}

function nameOf(path: string): string {
  return basename(path.replace(/\\/g, "/").replace(/\/+$/, "")) || path;
}

async function readStore(kcodeHomeDir: string): Promise<WorkspaceRecord[]> {
  try {
    const raw = JSON.parse(await readFile(storePath(kcodeHomeDir), "utf8")) as Partial<StoreFile>;
    if (raw.version !== 1 || !Array.isArray(raw.workspaces)) return [];
    return raw.workspaces.filter(
      (item): item is WorkspaceRecord =>
        typeof item === "object" &&
        item !== null &&
        typeof item.path === "string" &&
        item.path !== "" &&
        typeof item.name === "string" &&
        typeof item.createdAt === "number" &&
        typeof item.updatedAt === "number",
    );
  } catch {
    return [];
  }
}

async function writeStore(kcodeHomeDir: string, workspaces: WorkspaceRecord[]): Promise<void> {
  const path = storePath(kcodeHomeDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ version: 1, workspaces } satisfies StoreFile, null, 2)}\n`, "utf8");
}

/** 添加/更新一个工作区；路径按 workspaceKey 归一化去重。 */
export async function addWorkspace(kcodeHomeDir: string, path: string): Promise<WorkspaceRecord> {
  const cleanPath = path.trim().replace(/[\\/]+$/, "");
  if (cleanPath === "") throw new Error("工作区路径不能为空");
  const records = await readStore(kcodeHomeDir);
  const key = workspaceKey(cleanPath);
  const now = Date.now();
  const existing = records.find((item) => workspaceKey(item.path) === key);
  if (existing !== undefined) {
    existing.path = cleanPath;
    existing.name = nameOf(cleanPath);
    existing.updatedAt = now;
    await writeStore(kcodeHomeDir, records);
    return existing;
  }
  const record: WorkspaceRecord = {
    path: cleanPath,
    name: nameOf(cleanPath),
    createdAt: now,
    updatedAt: now,
  };
  records.push(record);
  await writeStore(kcodeHomeDir, records);
  return record;
}

export async function removeWorkspace(kcodeHomeDir: string, path: string): Promise<boolean> {
  const key = workspaceKey(path);
  const records = await readStore(kcodeHomeDir);
  const next = records.filter((item) => workspaceKey(item.path) !== key);
  if (next.length === records.length) return false;
  await writeStore(kcodeHomeDir, next);
  return true;
}

export async function listWorkspaces(kcodeHomeDir: string): Promise<WorkspaceRecord[]> {
  return (await readStore(kcodeHomeDir)).sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name, "zh-CN"));
}

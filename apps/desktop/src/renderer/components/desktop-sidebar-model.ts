/** 工作区树的数据模型/纯函数（Slice 1）。 */
import { sessionWorkspace } from "../lib/session-workspaces.js";

export interface SessionSummary {
  sessionId: string;
  preview: string;
  turns: number;
  modifiedAt?: number;
  workspaceKey?: string;
  title?: string;
  archived?: boolean;
  deleted?: boolean;
}

export interface Workspace {
  key: string;
  path: string;
  name: string;
  sessions: SessionSummary[];
  /** 注册表创建顺序；不在注册表中的工作区固定为 0。 */
  createdAt: number;
}

export interface WorkspaceSummary {
  path: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  trusted: boolean;
}

export type VisibleWorkspace = Workspace & { visibleSessions: SessionSummary[] };
export type SortMode = "created" | "name";

export const KNOWN_WORKSPACES = "kcode-desktop-workspaces";

export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function pathName(value: string): string {
  const parts = value.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) ?? value;
}

export function relativeTime(ts: number | undefined): string {
  if (ts === undefined) return "";
  const diff = Date.now() - ts;
  if (diff < 5 * 60_000) return "刚刚";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 365 * 24 * 60 * 60_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function hasContent(session: SessionSummary): boolean {
  return session.turns > 0 || (session.title?.trim() ?? "") !== "" || session.preview.trim() !== "";
}

export function workspaceOf(session: SessionSummary): string {
  const key = normalizePath(session.workspaceKey ?? "");
  if (key !== "" && key !== "/") return key;
  // 旧版 session_start 可能没有 workspaceKey；用 renderer 创建时记下的归属兜底。
  return normalizePath(sessionWorkspace(session.sessionId));
}

export function sessionTitle(session: SessionSummary, currentId: string | null): string {
  if (session.sessionId === currentId && !hasContent(session)) return "新任务";
  return session.title ?? (session.preview === "" ? "（空会话）" : session.preview);
}

export function loadKnown(): string[] {
  try {
    const raw = localStorage.getItem(KNOWN_WORKSPACES);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((item): item is string => typeof item === "string" && item.trim() !== ""))]
      : [];
  } catch {
    return [];
  }
}

/**
 * 桌面端会话本地索引（乐观 UI，host 列表仍是最终来源）。
 *
 * 新版 session_start 可能暂未带 workspaceKey，且新建空会话还没进入 sessions/list；
 * renderer 记下 sessionId → cwd / createdAt / 首条消息，侧栏先把这行稳定显示出来。
 */
const KEY = "kcode-desktop-session-workspaces-v3";
const LEGACY_KEY = "kcode-desktop-session-workspaces";

export interface LocalSession {
  sessionId: string;
  cwd: string;
  createdAt: number;
  preview?: string;
}

type Stored = Record<string, { cwd: string; createdAt: number; preview?: string }>;

function read(): Stored {
  // v1 在旧逻辑里会把“点击过的历史会话”误记成当前工作区，直接丢弃。
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // ignore
  }
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Stored = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (id === "") continue;
      if (typeof value === "string" && value !== "") {
        out[id] = { cwd: value, createdAt: 0 };
      } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const item = value as Partial<{ cwd: unknown; createdAt: unknown; preview: unknown }>;
        if (typeof item.cwd !== "string" || item.cwd === "") continue;
        out[id] = {
          cwd: item.cwd,
          createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
          ...(typeof item.preview === "string" ? { preview: item.preview } : {}),
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function write(map: Stored): void {
  try {
    const entries = Object.entries(map)
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(-300);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // 不阻塞会话；无 localStorage 时只少了乐观展示。
  }
}

export function rememberSessionWorkspace(sessionId: string, cwd: string): void {
  if (sessionId === "" || cwd === "") return;
  const map = read();
  const previous = map[sessionId];
  map[sessionId] = {
    cwd,
    createdAt: previous?.createdAt ?? Date.now(),
    ...(previous?.preview !== undefined ? { preview: previous.preview } : {}),
  };
  write(map);
}

export function listLocalSessions(): LocalSession[] {
  return Object.entries(read())
    .map(([sessionId, item]) => ({
      sessionId,
      cwd: item.cwd,
      createdAt: item.createdAt,
      ...(item.preview !== undefined ? { preview: item.preview } : {}),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function sessionWorkspace(sessionId: string): string {
  return read()[sessionId]?.cwd ?? "";
}

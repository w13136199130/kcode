import { join } from "node:path";
import { deleteSession, listSessions, renameSession, type SessionSummary } from "@kcode/runtime";
import { workspaceKey } from "@kcode/shared";

type Write = (line: string) => void;

/** 3-04：当前项目作用域的会话 list/rename/rm（与 TUI `/resume` 同一过滤规则） */
export async function sessionsCommand(
  cwd: string,
  kcodeHomeDir: string,
  args: string[],
  write: Write,
): Promise<boolean> {
  const dir = join(kcodeHomeDir, "cli", "sessions");
  const all = await listSessions(dir);
  const key = workspaceKey(cwd);
  const sessions = all.filter((s) => s.workspaceKey === "" || s.workspaceKey === key);
  const op = args[0] ?? "list";

  if (op === "list") {
    if (sessions.length === 0) {
      write("（当前项目暂无历史会话）");
      return true;
    }
    for (const s of sessions) {
      const title = s.title ?? (s.preview === "" ? "（空会话）" : s.preview);
      write(`${s.sessionId} · ${s.turns} 轮 · ${title}`);
    }
    return true;
  }

  const target = args[1];
  if (target === undefined) {
    write(`用法：kcode sessions ${op} <id|前缀|latest>${op === "rename" ? " <标题…>" : ""}`);
    return false;
  }
  const resolved = resolve(sessions, target);
  if (typeof resolved === "string") {
    write(`✗ ${resolved}`);
    return false;
  }

  if (op === "rename") {
    const title = args.slice(2).join(" ").trim();
    if (title === "") {
      write("用法：kcode sessions rename <id|latest> <标题…>");
      return false;
    }
    await renameSession(dir, resolved.sessionId, title);
    write(`✓ 已重命名 ${resolved.sessionId.slice(0, 16)}…：${title}`);
    return true;
  }
  if (op === "rm" || op === "delete") {
    await deleteSession(dir, resolved.sessionId);
    write(`✓ 已删除会话 ${resolved.sessionId}`);
    return true;
  }
  write("用法：kcode sessions list|rename <id> <标题>|rm <id>");
  return false;
}

function resolve(sessions: SessionSummary[], target: string): SessionSummary | string {
  if (target === "latest") {
    const latest = [...sessions].sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
    return latest ?? "当前项目暂无历史会话";
  }
  if (sessions.some((s) => s.sessionId === target)) {
    return sessions.find((s) => s.sessionId === target)!;
  }
  const matches = sessions.filter((s) => s.sessionId.startsWith(target));
  if (matches.length === 0) return `未找到会话「${target}」`;
  if (matches.length > 1) return `会话前缀「${target}」不唯一：${matches.map((s) => s.sessionId).join(", ")}`;
  return matches[0]!;
}

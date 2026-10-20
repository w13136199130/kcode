import { join, resolve } from "node:path";
import { atomicWriteText } from "@kcode/tools";
import { effectiveEvents, listSessions, loadSessionEvents, type SessionSummary } from "@kcode/runtime";
import { workspaceKey } from "@kcode/shared";
import { eventsToMarkdown, serializeEvents } from "./tui/export.js";

type Write = (line: string) => void;

/** 3-06：kcode export [id|latest] [路径]——历史会话也走 JSONL 事实源 */
export async function exportCommand(
  cwd: string,
  kcodeHomeDir: string,
  args: string[],
  write: Write,
): Promise<boolean> {
  const summaries = await listSessions(join(kcodeHomeDir, "cli", "sessions"));
  const key = workspaceKey(cwd);
  const scoped = summaries.filter((s) => s.workspaceKey === "" || s.workspaceKey === key);
  const wanted = args[0] ?? "latest";
  const target = resolveTarget(scoped, wanted);
  if (typeof target === "string") {
    write(`✗ ${target}`);
    return false;
  }

  const events = effectiveEvents(await loadSessionEvents(target.filePath));
  const outPath =
    args[1] !== undefined && args[1] !== ""
      ? resolve(cwd, args[1])
      : join(cwd, `kcode-session-${target.sessionId.slice(0, 8)}.md`);
  const content = outPath.endsWith(".jsonl") ? serializeEvents(events) : eventsToMarkdown(events);
  await atomicWriteText(outPath, content);
  write(`✓ 已导出 ${target.sessionId}（${events.length} 个事件）→ ${outPath}`);
  return true;
}

function resolveTarget(sessions: SessionSummary[], wanted: string): SessionSummary | string {
  if (sessions.length === 0) return "当前项目暂无可导出的历史会话";
  if (wanted === "latest") {
    return [...sessions].sort((a, b) => b.modifiedAt - a.modifiedAt)[0]!;
  }
  const exact = sessions.find((s) => s.sessionId === wanted);
  if (exact !== undefined) return exact;
  const matches = sessions.filter((s) => s.sessionId.startsWith(wanted));
  if (matches.length === 0) return `未找到会话「${wanted}」`;
  if (matches.length > 1) return `会话前缀「${wanted}」不唯一：${matches.map((s) => s.sessionId).join(", ")}`;
  return matches[0]!;
}

import { join } from "node:path";
import {
  cleanupStorage,
  deleteSession,
  listSessions,
  removeSessionData,
  renameSession,
  type RetentionOptions,
  type SessionSummary,
} from "@kcode/runtime";
import { workspaceKey } from "@kcode/shared";

type Write = (line: string) => void;

function flagValue(args: string[], flag: string): number | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const raw = args[index + 1];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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

  if (op === "vacuum" || op === "cleanup") {
    const dryRun = args.includes("--dry-run");
    const options: Partial<RetentionOptions> = {
      ...(flagValue(args, "--max-sessions") !== undefined ? { maxSessions: flagValue(args, "--max-sessions")! } : {}),
      ...(flagValue(args, "--max-age-days") !== undefined ? { maxAgeDays: flagValue(args, "--max-age-days")! } : {}),
      ...(flagValue(args, "--max-artifact-mb") !== undefined
        ? { maxArtifactBytes: flagValue(args, "--max-artifact-mb")! * 1024 * 1024 }
        : {}),
      ...(flagValue(args, "--max-audit-mb") !== undefined
        ? { maxAuditBytes: flagValue(args, "--max-audit-mb")! * 1024 * 1024 }
        : {}),
      dryRun,
    };
    const result = await cleanupStorage(kcodeHomeDir, options);
    write(
      `${result.dryRun ? "（dry-run，未删除）" : "✓"} 保留策略：删除会话 ${result.deletedSessions.length} 个 · 派生条带 ${result.deletedPaths.length} 个 · 释放 ${mb(result.freedBytes)} · 保留会话 ${result.keptSessions} 个 · 产物 ${mb(result.artifactBytes)} / 审计 ${mb(result.auditBytes)}`,
    );
    if (result.deletedSessions.length > 0) {
      write(`  会话：${result.deletedSessions.slice(0, 10).join("、")}${result.deletedSessions.length > 10 ? "…" : ""}`);
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
    // 3-30：rm 级联清理产物/检查点/审计，避免留下无主数据
    const freed = await removeSessionData(kcodeHomeDir, resolved.sessionId);
    write(`✓ 已删除会话 ${resolved.sessionId}（连带释放 ${mb(freed)}）`);
    return true;
  }
  write("用法：kcode sessions list|rename <id> <标题>|rm <id>|vacuum [--dry-run] [--max-sessions N] [--max-age-days N] [--max-artifact-mb N] [--max-audit-mb N]");
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

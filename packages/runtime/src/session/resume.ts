import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEvent } from "@kcode/contracts";
import { parseJsonlPrefix } from "./replayer.js";

export interface SessionSummary {
  sessionId: string;
  filePath: string;
  modifiedAt: number;
  /** 用户提问轮数 */
  turns: number;
  /** 首条用户消息预览 */
  preview: string;
  /** 工作区身份键（无 session_start 时为空串） */
  workspaceKey: string;
  /** D1-03：用户自定义标题（sidecar `<id>.title`；缺省用 preview） */
  title?: string;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

function titlePath(sessionsDir: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error("会话 id 不合法");
  return join(sessionsDir, `${sessionId}.title`);
}

/** 自定义标题（最多 80 字；空标题 = 删除 sidecar，回退 preview） */
export async function renameSession(sessionsDir: string, sessionId: string, title: string): Promise<void> {
  const path = titlePath(sessionsDir, sessionId);
  const clean = title.trim().slice(0, 80);
  if (clean === "") {
    await rm(path, { force: true });
    return;
  }
  await writeFile(path, `${clean}\n`, "utf8");
}

/** 删除会话文件与标题 sidecar（调用方负责拒绝删除当前活动会话） */
export async function deleteSession(sessionsDir: string, sessionId: string): Promise<void> {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error("会话 id 不合法");
  await Promise.all([
    rm(join(sessionsDir, `${sessionId}.jsonl`), { force: true }),
    rm(titlePath(sessionsDir, sessionId), { force: true }),
  ]);
}

/** 列出会话目录里的历史会话（按修改时间倒序；损坏文件跳过） */
export async function listSessions(sessionsDir: string): Promise<SessionSummary[]> {
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return []; // 目录不存在视为无历史
  }
  const summaries: SessionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const filePath = join(sessionsDir, name);
    try {
      const [fileStat, text] = await Promise.all([stat(filePath), readFile(filePath, "utf8")]);
      const events = parseJsonlPrefix(text);
      if (events.length === 0) continue; // 无有效事件（空文件或首行即损坏）：跳过，不当会话列出
      let turns = 0;
      let preview = "";
      let workspaceKey = "";
      for (const event of events) {
        if (event.type === "session_start") {
          workspaceKey = event.workspaceKey ?? event.cwd ?? "";
        } else if (event.type === "user_message") {
          turns += 1;
          if (preview === "") preview = event.content.slice(0, 60);
        }
      }
      const sessionId = name.replace(/\.jsonl$/, "");
      let title: string | undefined;
      try {
        const raw = (await readFile(titlePath(sessionsDir, sessionId), "utf8")).trim();
        if (raw !== "") title = raw;
      } catch {
        // 无标题 sidecar
      }
      summaries.push({
        sessionId,
        filePath,
        modifiedAt: fileStat.mtimeMs,
        turns,
        preview,
        workspaceKey,
        ...(title !== undefined ? { title } : {}),
      });
    } catch {
      // 单个损坏文件不阻断列表
    }
  }
  // 按工作区分组（再按最近优先）：同一项目的会话聚在一起，便于按项目查看与续接
  return summaries.sort((a, b) =>
    a.workspaceKey !== b.workspaceKey
      ? a.workspaceKey.localeCompare(b.workspaceKey)
      : b.modifiedAt - a.modifiedAt,
  );
}

/** 读取一个历史会话的完整事件流 */
export async function loadSessionEvents(filePath: string): Promise<SessionEvent[]> {
  return parseJsonlPrefix(await readFile(filePath, "utf8"));
}

export interface SessionSearchHit {
  sessionId: string;
  title?: string;
  workspaceKey: string;
  line: number;
  snippet: string;
}

/** 跨会话全文搜索：直接查 JSONL 文本，返回命中的会话/行；每会话最多 3 条。 */
export async function searchSessions(
  sessionsDir: string,
  query: string,
  limit = 20,
): Promise<SessionSearchHit[]> {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const summaries = await listSessions(sessionsDir);
  const hits: SessionSearchHit[] = [];
  for (const summary of summaries) {
    if (hits.length >= limit) break;
    let text: string;
    try {
      text = await readFile(summary.filePath, "utf8");
    } catch {
      continue;
    }
    let found = 0;
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (line.toLowerCase().includes(needle)) {
        hits.push({
          sessionId: summary.sessionId,
          ...(summary.title !== undefined ? { title: summary.title } : {}),
          workspaceKey: summary.workspaceKey,
          line: index + 1,
          snippet: line.slice(0, 240),
        });
        found += 1;
        if (found >= 3 || hits.length >= limit) break;
      }
    }
  }
  return hits;
}

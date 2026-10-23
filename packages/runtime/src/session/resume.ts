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

export type SessionSearchHitKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  | "summary"
  | "skill"
  | "todo";

export interface SessionSearchHit {
  sessionId: string;
  title?: string;
  workspaceKey: string;
  line: number;
  snippet: string;
  /** 命中字段来源（展示层标注“用户/助手/工具…”；不把 JSONL 元数据当正文） */
  kind?: SessionSearchHitKind;
}

interface SearchCandidate {
  text: string;
  kind: SessionSearchHitKind;
}

/** JSONL 行 → 可搜索的可见文本；不返回 uuid/sessionId/type 等元数据 */
function searchCandidates(event: Record<string, unknown>): SearchCandidate[] {
  const field = (key: string): string => (typeof event[key] === "string" ? (event[key] as string) : "");
  const collectStrings = (value: unknown, out: string[] = []): string[] => {
    if (typeof value === "string") {
      out.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) collectStrings(item, out);
    } else if (value !== null && typeof value === "object") {
      for (const item of Object.values(value)) collectStrings(item, out);
    }
    return out;
  };
  switch (event["type"]) {
    case "user_message":
      return [{ text: field("content"), kind: "user" }];
    case "assistant_message":
      return [
        { text: field("content"), kind: "assistant" },
        { text: field("reasoning"), kind: "reasoning" },
      ];
    case "tool_result":
      return [
        { text: field("output"), kind: "tool" },
        { text: field("error"), kind: "tool" },
      ];
    case "tool_call": {
      // 只取工具名 + 参数值（command/path/pattern…），不拼 callId/type 这类 JSONL 元数据
      const args = collectStrings(event["args"]).join(" ");
      return [{ text: `${field("tool")} ${args}`, kind: "tool" }];
    }
    case "compaction_summary":
      return [{ text: field("summary"), kind: "summary" }];
    case "skill_used":
      return [{ text: field("skill"), kind: "skill" }];
    case "todo_update":
      return [{ text: collectStrings(event["todos"]).join(" "), kind: "todo" }];
    default:
      return [];
  }
}

const SNIPPET_CHARS = 180;

/** 命中位置附近截取纯文本摘要；空白压平，保留 query 上下文 */
function makeSnippet(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(needle);
  if (at < 0) return flat.slice(0, SNIPPET_CHARS);
  const width = Math.max(SNIPPET_CHARS, needle.length + 40);
  const half = Math.floor((width - needle.length) / 2);
  let start = Math.max(0, at - half);
  let end = Math.min(flat.length, start + width);
  start = Math.max(0, end - width);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
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
      if (!line.toLowerCase().includes(needle)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== "object") continue;
      const candidate = searchCandidates(parsed as Record<string, unknown>).find(
        (item) => item.text !== "" && item.text.toLowerCase().includes(needle),
      );
      if (candidate === undefined) continue;
      hits.push({
        sessionId: summary.sessionId,
        ...(summary.title !== undefined ? { title: summary.title } : {}),
        workspaceKey: summary.workspaceKey,
        line: index + 1,
        snippet: makeSnippet(candidate.text, needle),
        kind: candidate.kind,
      });
      found += 1;
      if (found >= 3 || hits.length >= limit) break;
    }
  }
  return hits;
}

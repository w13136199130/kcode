import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * 会话目录摘要的增量缓存（P1-1，指标 M1）。
 *
 * 桌面列表/reconcile 只需要 session_start 的 workspaceKey + 首条 user_message 预览，
 * 不需要全量解析 JSONL。缓存以 mtimeMs+size 双键失效：目录里大多数文件在两次
 * sessions/list 之间没有变化，stat 之后直接复用摘要，把每次列表从
 * O(所有文件全量读取) 降到 O(变化的文件)。
 *
 * 注意：turns 是头部近似值（桌面语义里只用 turns>0 判"有内容"）；CLI 的
 * listSessions（packages/runtime）保持全量精确语义，不受影响。
 */
export interface SummaryRow {
  sessionId: string;
  filePath: string;
  modifiedAt: number;
  turns: number;
  preview: string;
  workspaceKey: string;
  title?: string;
}

/** 头部读取上限：覆盖 session_start + 前几轮消息绰绰有余。 */
const HEAD_BYTES = 64 * 1024;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  /** null = 文件无有效事件（与原 listSessions 的跳过语义一致） */
  summary: SummaryRow | null;
  titleMtimeMs: number;
  title: string | undefined;
}

export class SessionSummaryCache {
  readonly #sessionsDir: string;
  readonly #cache = new Map<string, CacheEntry>();
  #headReads = 0;

  constructor(sessionsDir: string) {
    this.#sessionsDir = sessionsDir;
  }

  /** 实际读取文件头部的次数（测试断言"未变零读取"用）。 */
  get headReads(): number {
    return this.#headReads;
  }

  /** 列出会话目录摘要（按 mtime 倒序）；未变化文件零 IO。 */
  async list(): Promise<SummaryRow[]> {
    let names: string[];
    try {
      names = await readdir(this.#sessionsDir);
    } catch {
      return [];
    }
    const rows: SummaryRow[] = [];
    const seen = new Set<string>();
    const namesToRead: string[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      seen.add(name.replace(/\.jsonl$/, ""));
      namesToRead.push(name.replace(/\.jsonl$/, ""));
    }
    const entries = await Promise.all(
      namesToRead.map((sessionId) => this.#entry(sessionId).catch(() => undefined)),
    );
    for (const entry of entries) {
      if (entry !== undefined && entry.summary !== null) {
        rows.push({ ...entry.summary, ...(entry.title !== undefined ? { title: entry.title } : {}) });
      }
    }
    // 目录里已消失的会话同步清缓存，避免长期驻留与陈旧复活
    for (const id of this.#cache.keys()) {
      if (!seen.has(id)) this.#cache.delete(id);
    }
    return rows.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  async #entry(sessionId: string): Promise<CacheEntry | undefined> {
    const filePath = join(this.#sessionsDir, `${sessionId}.jsonl`);
    const fileStat = await stat(filePath).catch(() => null);
    if (fileStat === null) {
      this.#cache.delete(sessionId);
      return undefined;
    }
    const titleStat = await stat(join(this.#sessionsDir, `${sessionId}.title`)).catch(() => null);
    const titleMtimeMs = titleStat?.mtimeMs ?? 0;
    const prev = this.#cache.get(sessionId);
    const mainHit = prev !== undefined && prev.mtimeMs === fileStat.mtimeMs && prev.size === fileStat.size;
    const titleHit = prev !== undefined && prev.titleMtimeMs === titleMtimeMs;
    if (mainHit && titleHit) return prev;

    let summary: SummaryRow | null = prev?.summary ?? null;
    if (!mainHit) {
      this.#headReads += 1;
      summary = await this.#parseHead(sessionId, filePath, fileStat.mtimeMs);
    }
    const title = titleHit ? prev?.title : await this.#readTitle(sessionId, titleStat);
    const entry: CacheEntry = { mtimeMs: fileStat.mtimeMs, size: fileStat.size, summary, titleMtimeMs, title };
    this.#cache.set(sessionId, entry);
    return entry;
  }

  async #readTitle(sessionId: string, titleStat: Awaited<ReturnType<typeof stat>> | null): Promise<string | undefined> {
    if (titleStat === null) return undefined;
    try {
      const raw = (await readFile(join(this.#sessionsDir, `${sessionId}.title`), "utf8")).trim();
      return raw !== "" ? raw : undefined;
    } catch {
      return undefined;
    }
  }

  /** 只读文件头部并解析完整行；无有效事件返回 null。 */
  async #parseHead(sessionId: string, filePath: string, mtimeMs: number): Promise<SummaryRow | null> {
    let text: string;
    let tailText = "";
    let fileSize = 0;
    try {
      const handle = await open(filePath, "r");
      try {
        const stat = await handle.stat();
        fileSize = stat.size;
        const buf = Buffer.alloc(HEAD_BYTES);
        const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
        text = buf.subarray(0, bytesRead).toString("utf8");
        if (fileSize > HEAD_BYTES) {
          const tailLength = Math.min(HEAD_BYTES, fileSize);
          const tail = Buffer.alloc(tailLength);
          const { bytesRead: tailRead } = await handle.read(tail, 0, tailLength, fileSize - tailLength);
          tailText = tail.subarray(0, tailRead).toString("utf8");
        }
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
    // 头部可能正好切在一行中间：只取最后一个完整行之前的内容
    const lastNewline = text.lastIndexOf("\n");
    const lines = (lastNewline === -1 ? "" : text.slice(0, lastNewline)).split("\n");
    let anyEvent = false;
    let workspaceKey = "";
    let preview = "";
    let turns = 0;
    let lastTs = 0;
    const consume = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      let event: { type?: string; workspaceKey?: string; cwd?: string; content?: unknown; ts?: unknown };
      try {
        event = JSON.parse(trimmed) as typeof event;
      } catch {
        return; // 坏行跳过（与 parseJsonlPrefix 的宽松语义一致）
      }
      anyEvent = true;
      if (typeof event.ts === "number" && event.type !== "host_lease") {
        lastTs = Math.max(lastTs, event.ts);
      }
      if (event.type === "session_start") {
        workspaceKey = event.workspaceKey ?? event.cwd ?? "";
      } else if (event.type === "user_message") {
        turns += 1;
        if (preview === "") preview = String(event.content ?? "").slice(0, 60);
      }
    };
    for (const line of lines) consume(line);
    if (tailText !== "") {
      // 尾块可能从半行开始；丢弃第一段直到换行。
      const firstNewline = tailText.indexOf("\n");
      const tailLines = (firstNewline === -1 ? "" : tailText.slice(firstNewline + 1)).split("\n");
      for (const line of tailLines) consume(line);
    }
    if (!anyEvent) return null;
    return {
      sessionId,
      filePath,
      // 打开会话会 append host_lease，mtime 会变；排序/“刚刚”必须用最后一条真实事件。
      modifiedAt: lastTs > 0 ? lastTs : mtimeMs,
      turns,
      preview,
      workspaceKey,
    };
  }
}

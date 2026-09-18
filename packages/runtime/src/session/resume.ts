import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEvent } from "@kcode/contracts";
import { parseJsonlSession } from "./replayer.js";

export interface SessionSummary {
  sessionId: string;
  filePath: string;
  modifiedAt: number;
  /** 用户提问轮数 */
  turns: number;
  /** 首条用户消息预览 */
  preview: string;
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
      const events = parseJsonlSession(text);
      let turns = 0;
      let preview = "";
      for (const event of events) {
        if (event.type === "user_message") {
          turns += 1;
          if (preview === "") preview = event.content.slice(0, 60);
        }
      }
      summaries.push({
        sessionId: name.replace(/\.jsonl$/, ""),
        filePath,
        modifiedAt: fileStat.mtimeMs,
        turns,
        preview,
      });
    } catch {
      // 单个损坏文件不阻断列表
    }
  }
  return summaries.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/** 读取一个历史会话的完整事件流 */
export async function loadSessionEvents(filePath: string): Promise<SessionEvent[]> {
  return parseJsonlSession(await readFile(filePath, "utf8"));
}

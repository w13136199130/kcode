import { join } from "node:path";
import type { ChatMessage } from "@kcode/contracts";
import { trustProject as trustProjectOnFile } from "@kcode/extensions";
import {
  listSessions,
  loadSessionEvents,
  rebuildHistory,
  effectiveEvents,
} from "@kcode/runtime";
import type { SessionUsage } from "@kcode/core";
import { workspaceKey } from "@kcode/shared";

/**
 * 续接与信任工具（自 composition.ts 外迁）：两者都是无组合内部状态的独立导出物，
 * 留在 composition 里只会把该文件推向 max-lines 红线。
 */

/** 解析续接来源（latest / id 前缀 / 精确 id），返回种子历史与历史累计用量；找不到返回 null */
export async function resolveResumeHistory(
  kcodeHomeDir: string,
  resumeFrom: string,
  workspacePath?: string,
): Promise<{ messages: ChatMessage[]; usage: SessionUsage } | null> {
  const sessionsDir = join(kcodeHomeDir, "cli", "sessions");
  const summaries = await listSessions(sessionsDir);
  if (summaries.length === 0) {
    return null;
  }
  // "latest" 只在当前工作区内取最近：listSessions 已按 (workspaceKey, mtime) 排序，
  // 取首个匹配当前工作区的即为该工作区最近会话；未指定工作区时退化为全局最近。
  const scopeKey = workspacePath !== undefined ? workspaceKey(workspacePath) : undefined;
  const target =
    resumeFrom === "latest"
      ? scopeKey === undefined
        ? summaries[0]
        : summaries.find((s) => s.workspaceKey === scopeKey)
      : summaries.find((s) => s.sessionId === resumeFrom || s.sessionId.startsWith(resumeFrom));
  if (target === undefined) {
    return null;
  }
  const all = await loadSessionEvents(target.filePath);
  // 用量只累计**有效前缀**：已回退轮次的用量不应继续计入 /cost（否则回退后费用偏高）
  const events = effectiveEvents(all);
  const usage: SessionUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  for (const event of events) {
    if (event.type === "session_end" && event.usage !== undefined) {
      usage.inputTokens += event.usage.inputTokens;
      usage.outputTokens += event.usage.outputTokens;
      usage.calls += event.usage.calls;
    }
  }
  return { messages: rebuildHistory(events), usage };
}

/** 把项目写入受信任清单（幂等） */
export function trustProject(cwd: string, kcodeHomeDir: string): Promise<void> {
  return trustProjectOnFile(cwd, join(kcodeHomeDir, "trusted-projects.json"));
}

import type { SessionIndexEntry } from "./session-index.js";
import type { SummaryRow } from "./session-summaries.js";

export interface SessionPage {
  sessions: Array<{
    sessionId: string;
    preview: string;
    turns: number;
    modifiedAt: number;
    workspaceKey: string;
    title?: string;
    draft?: boolean;
    archived?: boolean;
    deleted?: boolean;
    ungrouped?: boolean;
  }>;
  total: number;
  hasMore: boolean;
}

/** 索引/JSONL 合并 + query 过滤 + 稳定分页；query 必须在 slice 之前。 */
export function pageSessions(input: {
  summaries: SummaryRow[];
  indexed: SessionIndexEntry[];
  archived: Set<string>;
  deleted: Set<string>;
  query: string;
  limit: number;
  offset: number;
}): SessionPage {
  const byId = new Map(input.summaries.map((summary) => [summary.sessionId, summary]));
  const metaById = new Map(input.indexed.map((meta) => [meta.sessionId, meta]));
  const merged = input.summaries.map((summary) => {
    const meta = metaById.get(summary.sessionId);
    return {
      sessionId: summary.sessionId,
      preview: summary.preview,
      turns: summary.turns,
      modifiedAt: summary.modifiedAt,
      workspaceKey: summary.workspaceKey !== "" ? summary.workspaceKey : (meta?.workspaceKey ?? ""),
      ...(summary.title !== undefined ? { title: summary.title } : {}),
      ...(meta?.ungrouped === true ? { ungrouped: true } : {}),
    };
  });
  for (const meta of input.indexed) {
    if (byId.has(meta.sessionId) || meta.status === "failed") continue;
    if (meta.status !== "draft" && (meta.preview ?? "") === "" && meta.title === undefined) continue;
    merged.push({
      sessionId: meta.sessionId,
      preview: meta.preview ?? "",
      turns: meta.preview !== undefined && meta.preview !== "" ? 1 : 0,
      modifiedAt: meta.updatedAt,
      workspaceKey: meta.workspaceKey,
      ...(meta.status === "draft" ? { draft: true } : {}),
      ...(meta.ungrouped === true ? { ungrouped: true } : {}),
      ...(meta.title !== undefined ? { title: meta.title } : {}),
    });
  }
  const sorted = merged
    .filter((session) => {
      if (input.query === "") return true;
      return `${session.title ?? ""}\n${session.preview}`.toLocaleLowerCase().includes(input.query);
    })
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
  const page = sorted.slice(input.offset, input.offset + input.limit).map((session) => ({
    ...session,
    ...(input.archived.has(session.sessionId) ? { archived: true } : {}),
    ...(input.deleted.has(session.sessionId) ? { deleted: true } : {}),
  }));
  return {
    sessions: page,
    total: sorted.length,
    hasMore: input.offset + page.length < sorted.length,
  };
}

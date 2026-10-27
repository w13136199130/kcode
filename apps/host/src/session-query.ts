import type { SessionPage } from "./session-page.js";
import { parsePageParams, pageSessions } from "./session-page.js";
import { reconcileSessionIndex, listSessionIndex } from "./session-index.js";
import { listArchived } from "./task-state.js";
import { listDeletedSessions } from "./session-trash.js";
import type { SummaryRow } from "./session-summaries.js";

/**
 * S2-5：会话查询接缝（sessions/list 的唯一实现入口）。
 * 现实现 = 摘要缓存 + 索引 reconcile + 归档/回收站叠加 → pageSessions；
 * 将来换 FTS/SQLite 后端只替换本模块（调用方与协议不动）——接缝先钉住，
 * 而不是等搜索规模撞墙时再做全身手术。
 */
export async function querySessionPage(
  kcodeHomeDir: string,
  cache: { list(): Promise<SummaryRow[]> },
  params: unknown,
): Promise<SessionPage> {
  const { query, limit, offset } = parsePageParams(params);
  const summaries = await cache.list();
  await reconcileSessionIndex(kcodeHomeDir, summaries).catch(() => undefined);
  const indexed = await listSessionIndex(kcodeHomeDir);
  const archived = await listArchived(kcodeHomeDir);
  const deleted = await listDeletedSessions(kcodeHomeDir);
  return pageSessions({ summaries, indexed, archived, deleted, query, limit, offset });
}

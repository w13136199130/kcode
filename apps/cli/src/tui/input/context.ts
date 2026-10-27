import type { SessionUsage } from "@kcode/core";

/** S3-2：/context 注入项条目（与 core contextItems 同形；tokens 均为估算）。 */
interface ContextStatItem {
  label: string;
  tokens: number;
  detail?: string;
}

export interface ContextStat {
  model: string;
  contextWindow: number;
  windowKnown: boolean;
  historyTokens: number;
  historyBudget: number;
  systemTokens: number;
  items: ContextStatItem[];
  sessionUsage?: Partial<SessionUsage>;
  sessionBudgetTokens?: number;
}

const fmt = (n: number): string => n.toLocaleString("en-US");

/** /context 表格：注入项逐条（tokens + 占窗口比）+ 汇总 + 会话用量；纯函数便于单测。 */
export function formatContextStats(stats: ContextStat, modelLabel: string): string {
  const window = stats.contextWindow > 0 ? stats.contextWindow : 0;
  const pct = (tokens: number): string => (window > 0 ? `${((tokens / window) * 100).toFixed(1)}%` : "—");
  const lines: string[] = [`📊 上下文预算 · ${stats.model || modelLabel}`];
  if (!stats.windowKnown) lines.push("（模型窗口未知，按估算显示）");
  lines.push("");
  const rows = stats.items.length > 0 ? stats.items : [{ label: "历史消息", tokens: stats.historyTokens }];
  for (const item of rows) {
    const detail = item.detail !== undefined ? `（${item.detail}）` : "";
    lines.push(`  ${item.label}${detail}：${fmt(item.tokens)} tokens · ${pct(item.tokens)}`);
  }
  const total = rows.reduce((sum, item) => sum + item.tokens, 0);
  lines.push("");
  lines.push(`  合计（估算）：${fmt(total)} / ${fmt(window)} · ${pct(total)}`);
  if (stats.historyBudget > 0) {
    const used = Math.min(100, Math.round((stats.historyTokens / stats.historyBudget) * 100));
    const barLen = Math.max(1, Math.round(used / 2.5));
    lines.push(`  历史/压缩阈值 ${fmt(stats.historyTokens)} / ${fmt(stats.historyBudget)}（${used}%）`);
    lines.push(`  [${"█".repeat(barLen)}${"░".repeat(Math.max(0, 40 - barLen))}] 超预算自动压缩、/compact 手动压缩`);
  }
  const usage = stats.sessionUsage;
  if (usage !== undefined) {
    const used = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    lines.push(`  会话累计：输入 ${fmt(usage.inputTokens ?? 0)} · 输出 ${fmt(usage.outputTokens ?? 0)} · 调用 ${fmt(usage.calls ?? 0)}`);
    if (stats.sessionBudgetTokens !== undefined && stats.sessionBudgetTokens > 0) {
      lines.push(`  会话预算：${fmt(used)} / ${fmt(stats.sessionBudgetTokens)}（${((used / stats.sessionBudgetTokens) * 100).toFixed(0)}%）`);
    }
  }
  lines.push("");
  lines.push("  token 数为字符估算（含 MCP 工具定义成本——接入前先看这张表再决定留谁）。");
  return lines.join("\n");
}

import type { SessionUsage } from "@kcode/core";

/** 3-21：/cost 文本（纯函数便于测试；未知厂商缺分项时降级显示） */
export function formatCostUsage(usage: SessionUsage, modelLabel: string): string {
  const fmt = (n: number): string => n.toLocaleString("en-US");
  const known = usage.inputTokens > 0 || usage.outputTokens > 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const reasoning = usage.reasoningTokens ?? 0;
  const hasCache = cacheRead > 0 || cacheWrite > 0;
  const hasReasoning = reasoning > 0;
  const lines = [
    "⏱ 本会话用量：",
    `  输入 ${fmt(usage.inputTokens)} tok${hasCache ? `（缓存命中 ${fmt(cacheRead)} · 写入 ${fmt(cacheWrite)}）` : ""}`,
    `  输出 ${fmt(usage.outputTokens)} tok${hasReasoning ? `（推理 ${fmt(reasoning)}）` : ""}`,
    `  合计 ${fmt(usage.inputTokens + usage.outputTokens)} tok · LLM 调用 ${usage.calls} 次 · 当前模型 ${modelLabel}`,
  ];
  const models = Object.entries(usage.byModel ?? {});
  if (models.length > 0) {
    lines.push("按模型：");
    for (const [model, u] of models.sort(([a], [b]) => (a < b ? -1 : 1))) {
      const cache = (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
      lines.push(
        `  ${model}：输入 ${fmt(u.inputTokens)}${cache > 0 ? `（缓存 ${fmt(cache)}）` : ""} · 输出 ${fmt(u.outputTokens)}${(u.reasoningTokens ?? 0) > 0 ? `（推理 ${fmt(u.reasoningTokens ?? 0)}）` : ""} · ${u.calls} 次`,
      );
    }
  }
  const tools = Object.entries(usage.byTool ?? {}).sort(([, a], [, b]) => b - a);
  if (tools.length > 0) {
    const total = tools.reduce((sum, [, n]) => sum + n, 0);
    lines.push(`工具调用（${total} 次）：${tools.map(([tool, n]) => `${tool} ${n}`).join(" · ")}`);
  }
  if (usage.subagents !== undefined && usage.subagents.count > 0) {
    lines.push(
      `子代理（${usage.subagents.count} 个）：输入 ${fmt(usage.subagents.inputTokens)} tok · 输出 ${fmt(usage.subagents.outputTokens)} tok（主会话合计之外）`,
    );
  }
  if (!known) {
    lines.push("（BYOK 自带 key；端点未回报用量，仅显示调用次数）");
  } else if (!hasCache && !hasReasoning) {
    lines.push("（该厂商未回报缓存/推理分项，仅输入/输出可用）");
  }
  if (models.length === 0 && usage.calls > 0) {
    lines.push("（续接历史的分项从本进程开始累计）");
  }
  return `${lines.join("\n")}\n（BYOK 自带 key，按厂商定价计费）`;
}

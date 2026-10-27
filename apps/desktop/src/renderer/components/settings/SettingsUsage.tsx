import { useEffect, useState } from "react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";

/**
 * S1-6 + S2-6 第一片：使用统计（只读账本）。
 * 数据来自 host `usage/summary`——跨会话聚合各 JSONL 尾部 session_end.usage，
 * 超大转写的中段轮次可能漏计，页面必须保留「估算」标注（不伪造精确）。
 */
interface Ledger {
  approximate: true;
  sessions: number;
  totals: { inputTokens: number; outputTokens: number; calls: number };
  byModel: Array<{ model: string; inputTokens: number; outputTokens: number; calls: number }>;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function SettingsUsage({ conn }: { conn: HostConnection }) {
  const [data, setData] = useState<Ledger | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void conn
      .send("usage/summary")
      .then((r) => setData(r as Ledger))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [conn]);

  if (error !== "") return <div className="sv-error">读取失败：{error}</div>;
  if (data === null) return <div className="sv-hint">统计中…</div>;
  return (
    <div className="sv-usage" data-testid="usage-summary">
      <div className="sv-hint">
        按各会话转写尾部的 session_end 用量聚合（{data.sessions} 个会话）——超大转写的中段轮次可能漏计，数字为估算。
      </div>
      <div className="sv-usage-cards">
        <div className="sv-usage-card">
          <span className="sv-usage-num">{fmt(data.totals.inputTokens)}</span>
          <span>输入 tokens（估算）</span>
        </div>
        <div className="sv-usage-card">
          <span className="sv-usage-num">{fmt(data.totals.outputTokens)}</span>
          <span>输出 tokens（估算）</span>
        </div>
        <div className="sv-usage-card">
          <span className="sv-usage-num">{fmt(data.totals.calls)}</span>
          <span>模型调用次数</span>
        </div>
      </div>
      {data.byModel.length > 0 ? (
        <table className="sv-usage-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>输入</th>
              <th>输出</th>
              <th>调用</th>
            </tr>
          </thead>
          <tbody>
            {data.byModel.map((row) => (
              <tr key={row.model} data-model={row.model}>
                <td>{row.model}</td>
                <td>{fmt(row.inputTokens)}</td>
                <td>{fmt(row.outputTokens)}</td>
                <td>{fmt(row.calls)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="sv-hint">还没有可统计的会话</div>
      )}
    </div>
  );
}

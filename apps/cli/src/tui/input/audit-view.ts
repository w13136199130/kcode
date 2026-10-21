import type { AuditRecord } from "@kcode/core";
import { stripEscapes } from "../terminal/sanitize.js";

/** 3-29：/audit 文本（纯函数，便于测试） */
export function formatAuditRecords(records: readonly AuditRecord[], path: string): string {
  if (records.length === 0) {
    return `审计记录为空（路径：${path}）`;
  }
  const time = (ts: number): string => {
    const d = new Date(ts);
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const lines = records.map((r) => {
    const scope = r.scope !== undefined ? ` scope=${r.scope}` : "";
    const duration = r.durationMs !== undefined ? ` · ${r.durationMs}ms` : "";
    const sandbox =
      r.sandbox !== undefined
        ? ` · sandbox=${r.sandbox.backend}${r.sandbox.sandboxed ? "" : "(inactive)"}${r.sandbox.mode !== undefined ? `/${r.sandbox.mode}` : ""}${
            r.sandbox.denied !== undefined
              ? ` denied=${r.sandbox.denied.kind}:${stripEscapes(r.sandbox.denied.target)}`
              : ""
          }`
        : "";
    const detail = r.detail !== undefined && r.detail !== "" ? ` · ${stripEscapes(r.detail).slice(0, 80)}` : "";
    return `${time(r.ts)} · ${stripEscapes(r.tool)} · ${r.decision}${scope}${duration}${sandbox}${detail}`;
  });
  return `审计记录（最近 ${records.length} 条，路径：${path}）：\n${lines.join("\n")}`;
}

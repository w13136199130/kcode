import { Text } from "ink";
import type { UsageStats } from "@kcode/ui";
import { c } from "../theme/theme.js";

/**
 * 运行状态行（N3-3 体验优化：对标 Claude Code 极简风格）：
 * - 运行中：`✻ Thinking… (3s)` 极简——不挤快捷键提示（用户在忙，提示是噪声）
 * - 快捷键提示移到 StatusBar 的空闲段（不 busy 时才显示）
 */
export function StatusLine(props: {
  label: string;
  elapsed: string;
  verbose: boolean;
  queuedCount: number;
  /** 运行中的工具名（优先显示具体在做什么） */
  toolNames?: readonly string[];
}) {
  const tools = props.toolNames ?? [];
  const activity = tools.length > 0 ? tools.slice(0, 3).join(", ") : props.label;
  return (
    <Text color="gray">
      {"  ✻ "}
      {activity}
      {props.elapsed}…{props.queuedCount > 0 ? <Text color={c("warning")}> · queued {props.queuedCount}</Text> : null}
    </Text>
  );
}

/** token 数的人话化：千位以下原样，以上以 k 计（过万取整，减少状态栏抖动） */
function fmtTokens(n: number): string {
  if (n >= 10_000) {
    return `${Math.round(n / 1000)}k`;
  }
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/** 底部常驻状态栏：模式 — 模型 — 用量/余量 — 分支 — 快捷键提示；无数据的段自动隐藏不占位 */
export function StatusBar(props: {
  modeLabel: string;
  modelLabel: string;
  verbose: boolean;
  repaintTick: number;
  busy: boolean;
  /** 会话用量快照（N3C-4①）：null 时整段隐藏 */
  usage?: UsageStats | null;
  /** 当前 git 分支：null（非仓库/采样失败）时隐藏 */
  branch?: string | null;
}) {
  const usage = props.usage ?? null;
  // 余量占用超 85% 转警示色——这是"即将自动压缩"的预告
  const hot = usage !== null && usage.historyBudget > 0 && usage.historyTokens / usage.historyBudget > 0.85;
  const ctxPercent =
    usage !== null ? Math.round((usage.historyTokens / Math.max(usage.historyBudget, 1)) * 100) : 0;
  return (
    <Text dimColor wrap="truncate-end">
      {"  "}
      <Text color={c("brand")}>{props.modeLabel}</Text>
      {`  ${props.modelLabel}`}
      {usage !== null && (
        <Text color={hot ? c("warning") : undefined}>
          {` — ctx ${ctxPercent}%·${fmtTokens(usage.historyTokens)}/${fmtTokens(usage.historyBudget)} · ⇅${fmtTokens(usage.inputTokens)}/${fmtTokens(usage.outputTokens)}`}
        </Text>
      )}
      {props.branch != null && props.branch !== "" ? ` — ⎇ ${props.branch}` : ""}
      {props.busy ? (
        <Text dimColor> — Ctrl+C cancel · Ctrl+O {props.verbose ? "collapse" : "expand"}</Text>
      ) : (
        <Text dimColor> — /mode · /help · exit</Text>
      )}
    </Text>
  );
}

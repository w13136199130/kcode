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

/** 底部常驻状态栏（对齐批简化：默认最少——zcode/CC 同哲学，用量细节归 /cost /context）：
 * 模式 · 模型 · ctx 百分比（分母=压缩预算，即"距自动压缩"口径，85%+ 警示色）
 * · 分支 · busy 态场景提示（运行时才出现，非空闲装饰）。无数据的段自动隐藏。 */
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
      {usage !== null && <Text color={hot ? c("warning") : undefined}>{` — ctx ${ctxPercent}%`}</Text>}
      {props.branch != null && props.branch !== "" ? ` — ⎇ ${props.branch}` : ""}
      {props.busy ? (
        <Text dimColor> — Ctrl+C cancel · Ctrl+O {props.verbose ? "collapse" : "expand"}</Text>
      ) : null}
    </Text>
  );
}

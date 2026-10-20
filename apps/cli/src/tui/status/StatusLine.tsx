import { Text } from "ink";
import type { PermissionMode } from "@kcode/contracts";
import type { UsageStats } from "@kcode/ui";
import { c, glyph, rawColor } from "../theme/theme.js";
import { MODE_META } from "../theme/modes.js";
import { stripEscapes } from "../terminal/sanitize.js";

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
    <Text color={rawColor("gray")}>
      {`  ${glyph("✻", "*")} `}
      {activity}
      {props.elapsed}…{props.queuedCount > 0 ? <Text color={c("warning")}> · queued {props.queuedCount}</Text> : null}
    </Text>
  );
}

/**
 * 底部常驻状态栏（CC 样张形态）：`⏵⏵ 自动编辑（shift+tab 切换） · 模型 · 上下文 3% · ⎇ main`
 * - 模式段：glyph（⏸/⏵/⏵⏵/⏵⏵⏵ 递进速度隐喻）+ 中文标签白显，切换提示 muted（空闲才显示）
 * - 上下文百分比（分母=压缩预算，"距自动压缩"口径）——ctx 缩写换中文直觉措辞（反馈）
 * - busy 态场景提示运行时才出现；无数据段自动隐藏；用量绝对值归 /cost /context
 */
export function StatusBar(props: {
  mode: PermissionMode;
  modelLabel: string;
  verbose: boolean;
  repaintTick: number;
  busy: boolean;
  /** 会话用量快照（N3C-4①）：null 时整段隐藏 */
  usage?: UsageStats | null;
  /** 当前 git 分支：null（非仓库/采样失败）时隐藏 */
  branch?: string | null;
  /** 3-27：运行中的后台任务数（>0 才显示 ⚙ N） */
  runningTasks?: number;
}) {
  const usage = props.usage ?? null;
  // 余量占用超 85% 转警示色——这是"即将自动压缩"的预告
  const hot = usage !== null && usage.historyBudget > 0 && usage.historyTokens / usage.historyBudget > 0.85;
  const ctxPercent =
    usage !== null ? Math.round((usage.historyTokens / Math.max(usage.historyBudget, 1)) * 100) : 0;
  const meta = MODE_META[props.mode];
  const muted = c("foregroundSubtle");
  const modelShort = props.modelLabel.includes("/") ? props.modelLabel.split("/").slice(1).join("/") : props.modelLabel;
  return (
    <Text wrap="truncate-end">
      {"  "}
      <Text>
        {`${glyph(meta.glyph, meta.ascii)} ${meta.label}`}
        {props.busy ? null : <Text color={muted}>{"（shift+tab 切换）"}</Text>}
      </Text>
      <Text color={muted}>{` · ${stripEscapes(modelShort)}`}</Text>
      {usage !== null && <Text color={hot ? c("warning") : muted}>{` · 上下文 ${ctxPercent}%`}</Text>}
      {(props.runningTasks ?? 0) > 0 ? (
        <Text color={muted}>{` · ${glyph("⚙", "bg:")} ${props.runningTasks}`}</Text>
      ) : null}
      {props.branch != null && props.branch !== "" ? (
        <Text color={muted}>{` · ${glyph("⎇", "git:")} ${stripEscapes(props.branch)}`}</Text>
      ) : null}
      {props.busy ? (
        <Text color={muted}>{` · Ctrl+C 取消 · Ctrl+O ${props.verbose ? "收起" : "展开"}`}</Text>
      ) : null}
    </Text>
  );
}

import { Text } from "ink";
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

/** 底部常驻状态栏：模式 — 模型 — 空闲时快捷键提示（运行中隐藏，减噪声） */
export function StatusBar(props: {
  modeLabel: string;
  modelLabel: string;
  verbose: boolean;
  repaintTick: number;
  busy: boolean;
}) {
  return (
    <Text dimColor wrap="truncate-end">
      {"  "}
      <Text color={c("brand")}>{props.modeLabel}</Text>
      {`  ${props.modelLabel}`}
      {props.busy ? (
        <Text dimColor> — Ctrl+C cancel · Ctrl+O {props.verbose ? "collapse" : "expand"}</Text>
      ) : (
        <Text dimColor> — /mode · /help · exit</Text>
      )}
    </Text>
  );
}

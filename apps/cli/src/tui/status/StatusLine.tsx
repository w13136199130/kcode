import { Text } from "ink";

/** 运行状态行：活动标签 + 计时 + 排队数（N2-3 外迁，纯展示） */
export function StatusLine(props: {
  label: string;
  elapsed: string;
  menuOccupied: boolean;
  verbose: boolean;
  queuedCount: number;
}) {
  return (
    <Text dimColor>
      ✻ {props.label}{props.elapsed}…（Ctrl+C 取消整轮{props.menuOccupied ? "" : " · Esc 中断"} · Ctrl+O{" "}
      {props.verbose ? "折叠" : "展开"}）{props.queuedCount > 0 ? ` · 排队 ${props.queuedCount}` : ""}
    </Text>
  );
}

/** 底部常驻状态栏：模式 · 模型 · 快捷键提示（N2-3 外迁） */
export function StatusBar(props: {
  modeLabel: string;
  modelLabel: string;
  verbose: boolean;
  repaintTick: number;
}) {
  return (
    <Text dimColor wrap="truncate-end">
      {"⧉ "}{props.modeLabel}
      {props.repaintTick % 2 === 1 ? " " : " "}· {props.modelLabel} · /mode 切换 · Esc/Ctrl+C 中断 · Ctrl+O{" "}
      {props.verbose ? "折叠" : "展开"}思考 · exit 退出
    </Text>
  );
}

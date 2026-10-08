import type { ReactNode } from "react";
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { c } from "../theme/theme.js";

export interface MenuOption {
  /** 快捷键（单选时按下即选中并确认；多选时忽略） */
  key: string;
  label: string;
  /** 选中值（对齐批 B：/model 全量菜单等带注释 label 的场景，取值不再解析文本） */
  value?: string;
}

/**
 * 方向键选项菜单（对标 Claude Code 权限确认交互）：
 * ↑↓ 移动高亮（按键输入实时可见），回车确认选中项，Esc 取消；
 * 单选模式数字/快捷键直达，多选模式空格切换勾选。
 */
export function OptionsMenu(props: {
  options: MenuOption[];
  multi?: boolean;
  /** 初始高亮项（危险操作默认停在取消项） */
  initialIndex?: number;
  /** 取消语义标签（默认"Esc 取消"；工具审批面板传"Esc = 拒绝"——取消的对象是工具执行） */
  cancelLabel?: string;
  /** 选中项联动渲染（B5：ask_user 的 preview 展示） */
  footer?: (selectedIndex: number) => ReactNode;
  onPick: (indices: number[]) => void;
  onCancel: () => void;
}) {
  const count = props.options.length;
  const [selected, setSelected] = useState(props.initialIndex ?? 0);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  // 单一 Ink 输入通道（与 stdin 的读取模式不再打架——私加 data 监听会饿死 Ink 的 readable 循环）
  useInput((ch, key) => {
    if (key.upArrow) {
      setSelected((s) => (s - 1 + count) % count);
      return;
    }
    if (key.downArrow) {
      setSelected((s) => (s + 1) % count);
      return;
    }
    if (key.return) {
      if (props.multi === true) {
        props.onPick([...checked]);
      } else {
        props.onPick([selected]);
      }
      return;
    }
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (props.multi === true && ch === " ") {
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(selected)) {
          next.delete(selected);
        } else {
          next.add(selected);
        }
        return next;
      });
      return;
    }
    if (props.multi !== true) {
      const idx = props.options.findIndex((o) => o.key === ch.toLowerCase());
      if (idx !== -1) {
        props.onPick([idx]);
      }
    }
  });
  // 滚动窗口（对齐批 B：长清单不再整屏铺开——/model 全量菜单可达数十项；选中项滚入视野）
  const VISIBLE = 10;
  const start = Math.min(Math.max(0, selected - VISIBLE + 1), Math.max(0, count - VISIBLE));
  const visible = props.options.slice(start, start + VISIBLE);
  return (
    <Box flexDirection="column">
      {visible.map((o, i) => {
        const idx = start + i;
        const highlighted = idx === selected;
        const marker =
          props.multi === true ? (checked.has(idx) ? "☒" : "☐") : highlighted ? "❯" : " ";
        return (
          <Text key={o.key + String(idx)} color={highlighted ? c("brand") : undefined} bold={highlighted}>
            {marker} {idx + 1}. {o.label}
          </Text>
        );
      })}
      {props.footer !== undefined ? props.footer(selected) : null}
      <Text dimColor>
        {props.multi === true
          ? " ↑↓ 移动 · 空格勾选 · 回车确认 · Esc 取消"
          : ` ↑↓/数字 选择（${selected + 1}/${count}）· 回车确认 · ${props.cancelLabel ?? "Esc 取消"}`}
      </Text>
    </Box>
  );
}

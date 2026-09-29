import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { useStore } from "zustand";
import { readFile } from "node:fs/promises";
import { useServices, type UiStore, type BgTaskView } from "@kcode/ui";
import { truncateVisual } from "../terminal/width.js";
import { c } from "../theme/theme.js";
import type { CliServices } from "../state/services.js";

/**
 * 后台任务浏览器（N3C-4③）：Ctrl+T 打开的覆盖层面板，镜像 bash 工具注册表。
 * 任务完成没有事件（registry 只被 spawn 回写）——面板打开期间 1s 轮询刷新快照，
 * 关闭即停，空闲零成本；日志尾部按需异步读取（展开时）。
 * 键位在 terminal/keybinds.ts 统一处理，本组件只负责数据与渲染。
 */

/** 列表窗口大小（与工具浏览器一致） */
const WINDOW = 10;
/** 展开态日志尾部最多渲染行数 */
const TAIL_LINES = 40;
/** 打开期间的快照轮询间隔 */
const POLL_MS = 1000;

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function TaskBrowser(props: { ui: UiStore }) {
  const tasks = useStore(props.ui, (s) => s.backgroundTasks);
  const browser = useStore(props.ui, (s) => s.taskBrowser);
  const services = useServices<CliServices>();
  const [tail, setTail] = useState<{ id: string; text: string } | null>(null);

  // 打开期间低频轮询：任务状态变化（running → done/failed）无事件，轮询是最简正确解
  useEffect(() => {
    if (!browser.open) {
      return;
    }
    const refresh = (): void => {
      const session = services.getSession();
      props.ui.getState().setBackgroundTasks(session === null ? [] : session.backgroundTasks());
    };
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [browser.open, props.ui, services]);

  // 展开时读日志尾部（运行中的日志是追加流，读到的是当时的快照——与"看一眼进度"的语义一致）
  const expandedTask = tasks[browser.cursor];
  useEffect(() => {
    const wanted =
      browser.open && expandedTask !== undefined && browser.expandedId === expandedTask.id ? expandedTask : undefined;
    if (wanted === undefined) {
      setTail(null);
      return;
    }
    let cancelled = false;
    void readFile(wanted.logPath, "utf8")
      .then((text) => {
        if (!cancelled) {
          setTail({ id: wanted.id, text });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTail({ id: wanted.id, text: "" });
        }
      });
    return () => {
      cancelled = true;
    };
    // 依赖展开对象身份与状态（状态翻转时尾部要跟着刷新）；轮询换数组引用不应重触发
  }, [browser.open, browser.expandedId, expandedTask?.id, expandedTask?.status]);

  if (tasks.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={c("brand")} paddingX={1}>
        <Text dimColor>暂无后台任务——bash 工具带 runInBackground 参数的命令会出现在这里（Ctrl+T 或 Esc 关闭）</Text>
      </Box>
    );
  }

  const cursor = Math.min(browser.cursor, tasks.length - 1);
  const start = Math.max(0, Math.min(cursor - Math.floor(WINDOW / 2), tasks.length - WINDOW));
  const view = tasks.slice(start, start + WINDOW);
  const selected = tasks[cursor];
  const expanded = selected !== undefined && browser.expandedId === selected.id;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={c("brand")} paddingX={1}>
      <Text dimColor>
        后台任务 {cursor + 1}/{tasks.length}
        {start > 0 ? " ↑更多" : ""}
        {start + view.length < tasks.length ? " ↓更多" : ""} · ↑↓ 选择 · Enter 看日志尾部 · Ctrl+T/Esc 关闭
      </Text>
      {view.map((t, i) => {
        const index = start + i;
        const isSelected = index === cursor;
        const icon = t.status === "running" ? "⚡" : t.status === "failed" ? "✗" : "✓";
        const color = t.status === "failed" ? c("destructive") : t.status === "running" ? c("warning") : c("success");
        return (
          <Box key={t.id} flexDirection="column">
            <Text color={isSelected ? c("brand") : color} bold={isSelected}>
              {isSelected ? "❯ " : "  "}
              {icon} {t.id} <Text dimColor>{truncateVisual(t.command, 56)}</Text>
              {t.status === "running"
                ? ` (${formatMs(Date.now() - t.startedAt)})`
                : t.exitCode !== undefined
                  ? ` (exit ${t.exitCode})`
                  : ""}
            </Text>
            {isSelected && expanded && <TaskDetail task={t} tail={tail?.id === t.id ? tail.text : null} />}
          </Box>
        );
      })}
    </Box>
  );
}

/** 展开态详情：日志尾部 + 落盘路径（完整日志在文件里，面板只看尾） */
function TaskDetail(props: { task: BgTaskView; tail: string | null }) {
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text dimColor wrap="truncate-end">
        ⎿ 日志 {props.task.logPath}
      </Text>
      {props.tail === null ? (
        <Text dimColor>  （读取日志中…）</Text>
      ) : props.tail === "" ? (
        <Text dimColor>  （日志为空或暂不可读）</Text>
      ) : (
        (() => {
          const lines = props.tail.split("\n");
          const shown = lines.slice(-TAIL_LINES);
          return (
            <>
              {shown.map((line, j) => (
                <Text key={j} dimColor wrap="truncate-end">
                  {"  "}
                  {truncateVisual(line, 120)}
                </Text>
              ))}
              {lines.length > TAIL_LINES ? <Text dimColor>  …（显示尾部 {TAIL_LINES}/{lines.length} 行）</Text> : null}
            </>
          );
        })()
      )}
    </Box>
  );
}

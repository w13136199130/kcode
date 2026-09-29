import { useRef } from "react";
import { useInput } from "ink";
import type { PermissionMode } from "@kcode/contracts";
import type { Block, UiStore } from "@kcode/ui";

/**
 * 全局按键绑定（N2-3 外迁）：Esc（中断/空闲双击回退）、Shift+Tab（权限模式循环）、
 * Ctrl+C（中断/空闲双击退出）、Ctrl+B / Ctrl+T（工具卡片 / 后台任务浏览器，N3C-4②③）。
 * Ink 的 exitOnCtrlC 已关，退出语义在此自理；两个浏览器键位也集中在此——
 * 键位分散到面板组件会让"哪个键被谁吃了"不可审计。
 */
export function useKeybinds(deps: {
  busy: boolean;
  interactive: boolean;
  menuOccupied: boolean;
  inputEmpty: boolean;
  hasSession: boolean;
  mode: PermissionMode;
  ui: UiStore;
  interruptRun(): void;
  openRewindPicker(): void;
  applyMode(next: PermissionMode): void;
  exit(): void;
  pushBlock(block: Block): void;
}): void {
  const lastIdleEscAt = useRef(0);
  const lastCtrlCAt = useRef(0);
  // 任一覆盖层打开时其余键位让行（同一时刻只有一个键位层生效；两浏览器互斥由 slice 保证）
  const overlayActive = (): boolean => {
    const { toolBrowser, taskBrowser, historySearchOpen } = deps.ui.getState();
    return toolBrowser.open || taskBrowser.open || historySearchOpen;
  };

  // Esc：浏览器打开时仅关闭浏览器；历史搜索自己处理 Esc（这里只让行）；busy 时中断（菜单占用时 Esc 归菜单）；空闲双击 → /rewind
  useInput(
    (_ch, key) => {
      if (!key.escape) return;
      const state = deps.ui.getState();
      if (state.toolBrowser.open) {
        state.closeToolBrowser();
        return;
      }
      if (state.taskBrowser.open) {
        state.closeTaskBrowser();
        return;
      }
      if (state.historySearchOpen) {
        return; // HistorySearch 组件自己消费 Esc（关闭并回填输入）
      }
      if (deps.busy) {
        deps.interruptRun();
        return;
      }
      if (!deps.inputEmpty || !deps.hasSession) {
        lastIdleEscAt.current = 0;
        return; // 正在输入（可能是 IME 取消）不触发；双击窗口重置
      }
      const now = Date.now();
      if (now - lastIdleEscAt.current < 600) {
        lastIdleEscAt.current = 0;
        deps.openRewindPicker();
      } else {
        lastIdleEscAt.current = now;
      }
    },
    { isActive: deps.interactive && !deps.menuOccupied },
  );

  // Shift+Tab：权限模式循环 plan → default → acceptEdits（fullAccess 需菜单确认，不参与循环）
  useInput(
    (_ch, key) => {
      if (key.tab === true && key.shift === true && !deps.busy && !deps.menuOccupied && !overlayActive()) {
        const order: PermissionMode[] = ["plan", "default", "acceptEdits"];
        const idx = order.indexOf(deps.mode);
        deps.applyMode(order[(idx + 1) % order.length] ?? "default");
      }
    },
    { isActive: deps.interactive },
  );

  // Ctrl+C：busy 时中断；空闲时双击退出（浏览器打开不拦截——取消运行永远可用）
  useInput(
    (ch, key) => {
      if (key.ctrl && ch === "c") {
        if (deps.busy) {
          deps.interruptRun();
          return;
        }
        const now = Date.now();
        if (now - lastCtrlCAt.current < 1500) {
          deps.exit();
        } else {
          lastCtrlCAt.current = now;
          deps.pushBlock({ kind: "info", tone: "warn", text: "再按一次 Ctrl+C 退出（运行中按 Ctrl+C 为中断）" });
        }
      }
    },
    { isActive: deps.interactive },
  );

  // 浏览器键位（N3C-4②③）：Ctrl+B 工具卡片 / Ctrl+T 后台任务；打开时 ↑/↓ 移动、Enter 展开/收起。
  // 浏览器打开期间输入区被顶替（InputArea），方向键无第二消费者。
  useInput(
    (ch, key) => {
      const state = deps.ui.getState();
      if (state.toolBrowser.open || state.taskBrowser.open) {
        const target = state.toolBrowser.open ? "tool" : "task";
        if (key.upArrow) {
          if (target === "tool") state.moveToolCursor(-1);
          else state.moveTaskCursor(-1);
          return;
        }
        if (key.downArrow) {
          if (target === "tool") state.moveToolCursor(1);
          else state.moveTaskCursor(1);
          return;
        }
        if (key.return) {
          if (target === "tool") state.toggleToolDetail();
          else state.toggleTaskDetail();
          return;
        }
        if (key.ctrl && ch === "b") {
          // 切换语义：工具浏览器已开则收起；从任务浏览器切过来（互斥由 slice 收口）
          if (state.toolBrowser.open) state.closeToolBrowser();
          else state.openToolBrowser();
          return;
        }
        if (key.ctrl && ch === "t") {
          if (state.taskBrowser.open) state.closeTaskBrowser();
          else state.openTaskBrowser();
          return;
        }
        return; // 其余键位归浏览器（不透传到输入语义）
      }
      if (key.ctrl && ch === "b" && !deps.menuOccupied) {
        state.openToolBrowser();
        return;
      }
      if (key.ctrl && ch === "t" && !deps.menuOccupied) {
        state.openTaskBrowser();
      }
    },
    { isActive: deps.interactive },
  );
}

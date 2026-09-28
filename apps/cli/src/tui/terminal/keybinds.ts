import { useRef } from "react";
import { useInput } from "ink";
import type { PermissionMode } from "@kcode/contracts";
import type { Block } from "@kcode/ui";

/**
 * 全局按键绑定（N2-3 外迁）：Esc（中断/空闲双击回退）、Shift+Tab（权限模式循环）、
 * Ctrl+C（中断/空闲双击退出）。Ink 的 exitOnCtrlC 已关，退出语义在此自理。
 */
export function useKeybinds(deps: {
  busy: boolean;
  interactive: boolean;
  menuOccupied: boolean;
  inputEmpty: boolean;
  hasSession: boolean;
  mode: PermissionMode;
  interruptRun(): void;
  openRewindPicker(): void;
  applyMode(next: PermissionMode): void;
  exit(): void;
  pushBlock(block: Block): void;
}): void {
  const lastIdleEscAt = useRef(0);
  const lastCtrlCAt = useRef(0);

  // Esc：busy 时中断（菜单占用时 Esc 归菜单）；空闲且输入为空时双击 → /rewind 回退菜单
  useInput(
    (_ch, key) => {
      if (!key.escape) return;
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
      if (key.tab === true && key.shift === true && !deps.busy && !deps.menuOccupied) {
        const order: PermissionMode[] = ["plan", "default", "acceptEdits"];
        const idx = order.indexOf(deps.mode);
        deps.applyMode(order[(idx + 1) % order.length] ?? "default");
      }
    },
    { isActive: deps.interactive },
  );

  // Ctrl+C：busy 时中断；空闲时双击退出
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
}

import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

/**
 * 全局快捷键（capture；命令面板 ⌘K / 新会话 ⌘N / 侧栏 ⌘B）——S0-4 从 main.tsx 原样拆出。
 * deps 保持 []：setters 稳定、ref 可变，注册一次不重挂。
 */
export function useGlobalShortcuts(opts: {
  onNewSessionRef: MutableRefObject<(() => void) | null>;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
}): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        opts.setPaletteOpen((v) => !v);
      } else if (k === "n") {
        e.preventDefault();
        opts.onNewSessionRef.current?.();
      } else if (k === "b") {
        e.preventDefault();
        opts.setSidebarCollapsed((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 注册期只需稳定 setter 与 ref
  }, []);
}

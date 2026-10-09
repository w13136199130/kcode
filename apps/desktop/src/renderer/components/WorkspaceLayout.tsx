import { useCallback, useRef, useState, type ReactNode } from "react";

/**
 * 三栏布局（M2a，§8.4h）：侧栏 + 主区（Side Pane 占位 M3）。
 * 侧栏宽度走 CSS 变量（窗口原生 resize 不触发 React 重渲——zcode 实测经验），
 * 自绘 resize 手柄：pointer 拖拽 + 双击复位；Ctrl/⌘+B 折叠。
 */
export function WorkspaceLayout(props: {
  sidebar: ReactNode;
  main: ReactNode;
  /** 受控折叠（Ctrl+B / 命令面板共用一个状态源） */
  collapsed?: boolean;
  onToggleSidebar?(): void;
}) {
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const effectiveCollapsed = props.collapsed ?? internalCollapsed;
  const setCollapsed = setInternalCollapsed;
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const current = Number(
      document.documentElement.style.getPropertyValue("--workspace-sidebar-width").replace("px", "") || "264",
    );
    dragState.current = { startX: e.clientX, startWidth: collapsed ? 264 : current };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragState.current;
    if (drag === null) return;
    const width = Math.max(200, Math.min(480, drag.startWidth + e.clientX - drag.startX));
    document.documentElement.style.setProperty("--workspace-sidebar-width", `${width}px`);
  };

  const onPointerUp = (): void => {
    dragState.current = null;
  };

  const toggle = useCallback(() => {
    if (props.onToggleSidebar !== undefined) props.onToggleSidebar();
    else setCollapsed((v) => !v);
  }, [props.onToggleSidebar]);

  return (
    <div
      className="workspace-root"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
          e.preventDefault();
          toggle();
        }
      }}
    >
      <div className={`workspace-sidebar ${effectiveCollapsed ? "collapsed" : ""}`}>{props.sidebar}</div>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => document.documentElement.style.setProperty("--workspace-sidebar-width", "264px")}
      />
      <div className="workspace-main">{props.main}</div>
    </div>
  );
}

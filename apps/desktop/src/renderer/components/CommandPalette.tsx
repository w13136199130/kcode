import { useEffect, useMemo, useRef, useState } from "react";
import type { PermissionMode } from "@kcode/contracts";

/**
 * 命令面板（M3a，§8.4h M3）：Ctrl/⌘+K 覆盖层——模糊过滤 + ↑↓/Enter。
 * 命令即当前 renderer 可达动作（窗口/视图/模式）；快捷键单一事实源随 M3 后续
 * 抽成注册表（先静态清单）。
 */
interface Command {
  id: string;
  label: string;
  hint?: string;
  run(): void;
}

export function CommandPalette(props: {
  mode: PermissionMode;
  onClose(): void;
  onNewWindow(): void;
  onToggleSidebar(): void;
  onInterrupt(): void;
  onModeChange(mode: PermissionMode): void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commands: Command[] = useMemo(
    () => [
      { id: "new-window", label: "新建会话窗口", hint: "Ctrl+N", run: props.onNewWindow },
      { id: "toggle-sidebar", label: "显示/隐藏侧栏", hint: "Ctrl+B", run: props.onToggleSidebar },
      { id: "interrupt", label: "中断当前运行", hint: "Esc", run: props.onInterrupt },
      { id: "mode-plan", label: "模式：只读", run: () => props.onModeChange("plan") },
      { id: "mode-default", label: "模式：变更确认", run: () => props.onModeChange("default") },
      { id: "mode-accept", label: "模式：自动编辑", run: () => props.onModeChange("acceptEdits") },
      { id: "mode-full", label: "模式：完全访问", run: () => props.onModeChange("fullAccess") },
    ],
    [props.onNewWindow, props.onToggleSidebar, props.onInterrupt, props.onModeChange],
  );

  const filtered = commands.filter(
    (c) => query === "" || c.label.toLowerCase().includes(query.toLowerCase()),
  );

  const runAt = (i: number): void => {
    const cmd = filtered[i];
    if (cmd === undefined) return;
    props.onClose();
    cmd.run();
  };

  return (
    <div className="palette-backdrop" onClick={props.onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder="输入命令…"
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              props.onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              runAt(index);
            }
          }}
        />
        <div className="palette-list">
          {filtered.map((c, i) => (
            <button
              key={c.id}
              type="button"
              className={`palette-item ${i === index ? "active" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => runAt(i)}
            >
              <span>{c.label}</span>
              {c.hint !== undefined ? <span className="palette-hint">{c.hint}</span> : null}
            </button>
          ))}
          {filtered.length === 0 ? <div className="palette-empty">无匹配命令</div> : null}
        </div>
      </div>
    </div>
  );
}

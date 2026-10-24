import { FileText } from "lucide-react";
import type { PermissionMode } from "@kcode/contracts";

/**
 * 顶栏（M2a）：项目/会话标识 + 模型 + 模式标签（模式/模型选择器 M2b）。
 * 工作区名从 cwd 末段取——让用户始终知道当前会话在哪个项目里。
 */
export function WorkspaceHeader(props: {
  title: string;
  cwd?: string;
  model: string | null;
  mode: PermissionMode;
  onPickWorkspace?(): void;
  /** D2-05：打开 changed files / revert 侧栏 */
  onShowChanges?(): void;
  /** D2-07：打开后台任务侧栏 */
  onShowTasks?(): void;
}) {
  const modeLabel: Record<PermissionMode, string> = {
    plan: "⏸ 只读",
    default: "⏵ 变更确认",
    acceptEdits: "⏵⏵ 自动编辑",
    fullAccess: "⏵⏵⏵ 完全访问",
  };
  const cwdName =
    props.cwd !== undefined && props.cwd !== ""
      ? props.cwd.split(/[\\/]/).filter((s) => s !== "").pop() ?? props.cwd
      : props.title;
  return (
    <header className="workspace-header workspace-header-v2">
      <div className="wh-left">
        <span className="wh-icon"><FileText size={14} strokeWidth={1.7} /></span>
        <div className="wh-copy">
          <div className="workspace-title wh-title" title={props.cwd ?? props.title}>{cwdName}</div>
          {props.cwd !== undefined && props.cwd !== "" ? (
            <div className="wh-path" title={props.cwd}>{props.cwd}</div>
          ) : null}
        </div>
      </div>
      <div className="workspace-badges wh-actions">
        {props.model !== null ? <span className="wh-chip" title={props.model}>{props.model}</span> : null}
        <span className="wh-chip">{modeLabel[props.mode]}</span>
        {props.onShowChanges !== undefined ? (
          <button type="button" className="wh-action" onClick={props.onShowChanges}>变更</button>
        ) : null}
        {props.onShowTasks !== undefined ? (
          <button type="button" className="wh-action" onClick={props.onShowTasks}>任务</button>
        ) : null}
        {props.onPickWorkspace !== undefined ? (
          <button type="button" className="wh-action" onClick={props.onPickWorkspace}>打开文件夹</button>
        ) : null}
      </div>
    </header>
  );
}

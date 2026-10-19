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
    <header className="workspace-header">
      <div className="workspace-title" title={props.cwd ?? props.title}>
        {cwdName}
      </div>
      <div className="workspace-badges">
        {props.model !== null ? <span className="badge">{props.model}</span> : null}
        <span className="badge">{modeLabel[props.mode]}</span>
        {props.onPickWorkspace !== undefined ? (
          <button type="button" className="badge workspace-pick" onClick={props.onPickWorkspace}>
            打开文件夹
          </button>
        ) : null}
      </div>
    </header>
  );
}

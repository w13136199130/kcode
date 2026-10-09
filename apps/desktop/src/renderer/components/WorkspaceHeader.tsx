import type { PermissionMode } from "@kcode/contracts";

/** 顶栏（M2a）：项目/会话标识 + 模型 + 模式标签（模式/模型选择器 M2b） */
export function WorkspaceHeader(props: { title: string; model: string | null; mode: PermissionMode }) {
  const modeLabel: Record<PermissionMode, string> = {
    plan: "⏸ 只读",
    default: "⏵ 变更确认",
    acceptEdits: "⏵⏵ 自动编辑",
    fullAccess: "⏵⏵⏵ 完全访问",
  };
  return (
    <header className="workspace-header">
      <div className="workspace-title" title={props.title}>
        {props.title}
      </div>
      <div className="workspace-badges">
        {props.model !== null ? <span className="badge">{props.model}</span> : null}
        <span className="badge">{modeLabel[props.mode]}</span>
      </div>
    </header>
  );
}

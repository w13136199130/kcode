import type { HostConnection } from "@web/hooks/useHostConnection.js";
import type { Workspace } from "../components/desktop-sidebar-model.js";

/**
 * S3-3 期拆出：侧栏工作区轻量动作（复制路径 / 编辑器打开）——从 DesktopSidebar
 * 原样搬移（行数平衡）。归档仍走 useWorkspaceRegistry（需同步本地注册表状态，不在此处）。
 */
export function useSidebarWorkspaceActions(opts: {
  conn: HostConnection;
  setMenu(menu: { kind: "workspace" | "task"; key: string } | null): void;
  setNotice(value: string): void;
}): {
  copyPath(path: string): Promise<void>;
  openInEditor(workspace: Workspace): Promise<void>;
} {
  const copyPath = async (path: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      // 剪贴板不可用时忽略；不伪造成功提示。
    }
    opts.setMenu(null);
  };
  // S1-1（F5）：在编辑器中打开工作区（host 侧解析 KCODE_EDITOR/EDITOR/code）
  const openInEditor = async (workspace: Workspace): Promise<void> => {
    opts.setMenu(null);
    try {
      const result = (await opts.conn.send("workspace/open_editor", { path: workspace.path })) as { command?: string };
      opts.setNotice(`已用 ${result.command ?? "编辑器"} 打开「${workspace.name}」`);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  };
  return { copyPath, openInEditor };
}

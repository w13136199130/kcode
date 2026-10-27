import { useCallback, useState } from "react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";
import { SidePane } from "../components/SidePane.js";
import type { Row } from "../components/projection.js";

/**
 * 右侧详情栏状态（D2-05/07）：任务 / 变更 / 工具 diff 三选一。
 * 从 main.tsx 抽出，避免 renderer 入口继续膨胀（max-lines 500）。
 * S0-5：动作 useCallback 化——稳定引用是时间线行 memo 生效的前提。
 */
export function useWorkspacePanes(conn: HostConnection) {
  const [tasksOpen, setTasksOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [diffRow, setDiffRow] = useState<Extract<Row, { kind: "tool" }> | null>(null);

  const close = useCallback((): void => {
    setTasksOpen(false);
    setChangesOpen(false);
    setDiffRow(null);
  }, []);
  const openTasks = useCallback((): void => {
    setDiffRow(null);
    setChangesOpen(false);
    setTasksOpen(true);
  }, []);
  const openChanges = useCallback((): void => {
    setDiffRow(null);
    setTasksOpen(false);
    setChangesOpen(true);
  }, []);
  const openDiff = useCallback((row: Extract<Row, { kind: "tool" }>): void => {
    setTasksOpen(false);
    setChangesOpen(false);
    setDiffRow(row);
  }, []);

  const open = tasksOpen || changesOpen || diffRow !== null;
  return {
    sidePane: open ? (
      <SidePane
        conn={conn}
        tasksOpen={tasksOpen}
        changesOpen={changesOpen}
        diffRow={diffRow}
        onClose={close}
      />
    ) : undefined,
    sidePaneOpen: open,
    close,
    openTasks,
    openChanges,
    openDiff,
  };
}

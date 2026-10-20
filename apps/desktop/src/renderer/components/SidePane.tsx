import type { HostConnection } from "@web/hooks/useHostConnection.js";
import { ChangesPanel } from "./ChangesPanel.js";
import { DiffViewer } from "./DiffViewer.js";
import { TaskPanel } from "./TaskPanel.js";
import type { Row } from "./projection.js";

/** D2-05/07：右侧详情栏的单一入口（任务 > 变更 > 工具 diff） */
export function SidePane(props: {
  conn: HostConnection;
  tasksOpen: boolean;
  changesOpen: boolean;
  diffRow: Extract<Row, { kind: "tool" }> | null;
  onClose(): void;
}) {
  if (props.tasksOpen) return <TaskPanel conn={props.conn} onClose={props.onClose} />;
  if (props.changesOpen) return <ChangesPanel conn={props.conn} onClose={props.onClose} />;
  if (props.diffRow !== null) return <DiffViewer row={props.diffRow} />;
  return null;
}

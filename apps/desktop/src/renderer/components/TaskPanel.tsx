import { useEffect, useState } from "react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";

interface BackgroundTask {
  id: string;
  command: string;
  status: "running" | "done" | "failed";
  exitCode?: number;
  logPath: string;
  startedAt: number;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  return `${Math.floor(diff / 3_600_000)} 小时前`;
}

/** D2-07：后台 bash 任务面板（轮询 host 注册表，可 stop） */
export function TaskPanel(props: { conn: HostConnection; onClose(): void }) {
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      const r = (await props.conn.send("session/tasks")) as { tasks?: BackgroundTask[] };
      setTasks(r.tasks ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.conn.status]);

  const stop = async (id: string): Promise<void> => {
    setBusyId(id);
    try {
      await props.conn.send("session/task_stop", { id });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="tasks-panel">
      <div className="tasks-head">
        <span className="tasks-title">后台任务（{tasks.length}）</span>
        <button type="button" className="tasks-close" onClick={props.onClose} title="关闭">
          ×
        </button>
      </div>
      {error !== null ? <div className="tasks-error">{error}</div> : null}
      {tasks.length === 0 ? (
        <div className="tasks-empty">暂无后台任务（bash 的 wait=background / 长任务会出现在这里）</div>
      ) : (
        <div className="tasks-list">
          {tasks.map((t) => (
            <div key={t.id} className={`tasks-item status-${t.status}`}>
              <div className="tasks-command" title={t.command}>
                {t.command}
              </div>
              <div className="tasks-meta">
                <span>
                  {t.status === "running" ? "运行中" : t.status === "done" ? "已完成" : "失败"}
                  {t.exitCode !== undefined ? `（exit ${t.exitCode}）` : ""} · {relativeTime(t.startedAt)}
                </span>
                {t.status === "running" ? (
                  <button type="button" className="tasks-stop" disabled={busyId === t.id} onClick={() => void stop(t.id)}>
                    停止
                  </button>
                ) : null}
              </div>
              <div className="tasks-log" title={t.logPath}>
                {t.logPath}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

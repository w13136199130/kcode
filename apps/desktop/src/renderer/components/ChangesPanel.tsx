import { useEffect, useState } from "react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";

interface FileChange {
  path: string;
  diff: string;
  callIds: string[];
  existed: boolean;
}

/**
 * D2-05：本会话 changed files + 逐文件回退。
 * diff 由 host 从检查点前像生成；renderer 不读文件、不做业务判断。
 */
export function ChangesPanel(props: { conn: HostConnection; onClose(): void }) {
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      const r = (await props.conn.send("session/changes")) as { changes?: FileChange[] };
      const list = r.changes ?? [];
      setChanges(list);
      setError(null);
      if (openPath !== null && !list.some((c) => c.path === openPath)) setOpenPath(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load();
    // 面板打开期间轻刷新：agent 可能还在改文件（3s 足够，不刷爆 host）
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.conn.status]);

  const revert = async (paths?: string[]): Promise<void> => {
    if (!window.confirm(paths === undefined ? "回退本会话全部文件改动？" : `回退 ${paths[0] ?? ""}？`)) return;
    setBusy(true);
    try {
      await props.conn.send("session/revert", paths !== undefined ? { paths } : {});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="changes-panel">
      <div className="changes-head">
        <span className="changes-title">本会话变更（{changes.length}）</span>
        <span className="changes-actions">
          {changes.length > 0 ? (
            <button type="button" className="changes-revert-all" disabled={busy} onClick={() => void revert()}>
              全部回退
            </button>
          ) : null}
          <button type="button" className="changes-close" onClick={props.onClose} title="关闭">
            ×
          </button>
        </span>
      </div>
      {error !== null ? <div className="changes-error">{error}</div> : null}
      {changes.length === 0 ? (
        <div className="changes-empty">本会话还没有写/编辑文件（bash 造成的外部改动不在检查点范围）</div>
      ) : (
        <div className="changes-list">
          {changes.map((c) => (
            <div key={c.path} className="changes-file">
              <div className="changes-file-head" onClick={() => setOpenPath((v) => (v === c.path ? null : c.path))}>
                <span className="changes-path" title={c.path}>
                  {c.path}
                </span>
                <span className="changes-file-actions">
                  <button
                    type="button"
                    className="changes-revert"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void revert([c.path]);
                    }}
                  >
                    回退
                  </button>
                </span>
              </div>
              {openPath === c.path ? (
                <pre className="changes-diff">
                  {c.diff.split("\n").map((line, i) => (
                    <div
                      key={i}
                      className={
                        line.startsWith("+")
                          ? "diff-line diff-added"
                          : line.startsWith("-")
                            ? "diff-line diff-removed"
                            : "diff-line"
                      }
                    >
                      {line}
                    </div>
                  ))}
                </pre>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

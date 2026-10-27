import { useCallback, useEffect, useRef, useState } from "react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";

/** 当前工作区信任状态：只读查询 + 显式信任，不自动信任。 */
export function useWorkspaceTrust(conn: HostConnection, cwd: string) {
  const [trusted, setTrusted] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const querySeq = useRef(0);

  useEffect(() => {
    if (conn.status !== "ready" || cwd === "") {
      setTrusted(null);
      return;
    }
    let cancelled = false;
    const seq = ++querySeq.current;
    setDismissed(false);
    void conn
      .send("workspace/status", { path: cwd })
      .then((result) => {
        if (!cancelled && seq === querySeq.current) {
          setTrusted((result as { trusted?: boolean }).trusted === true);
        }
      })
      .catch(() => {
        if (!cancelled && seq === querySeq.current) setTrusted(null);
      });
    return () => {
      cancelled = true;
    };
  }, [conn.send, conn.status, cwd]);

  useEffect(() => {
    const onTrusted = (event: Event): void => {
      const path = (event as CustomEvent<string>).detail;
      if (path === cwd) setTrusted(true);
    };
    window.addEventListener("kcode-workspace-trust", onTrusted);
    return () => window.removeEventListener("kcode-workspace-trust", onTrusted);
  }, [cwd]);

  const trust = useCallback(async (): Promise<boolean> => {
    if (cwd === "") return false;
    // 作废在途的 status 查询，避免它晚到把刚信任的状态覆盖回 false。
    querySeq.current += 1;
    try {
      await conn.send("workspace/trust", { path: cwd });
      setTrusted(true);
      return true;
    } catch {
      return false;
    }
  }, [conn.send, cwd]);

  return {
    visible: trusted === false && !dismissed,
    dismiss: () => setDismissed(true),
    trust,
  };
}

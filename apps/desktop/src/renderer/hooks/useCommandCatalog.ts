import { useEffect, useState } from "react";
import { BUILTIN_COMMANDS, type CommandInfo } from "@kcode/contracts";
import type { HostConnection } from "@web/hooks/useHostConnection.js";

/** D1-05：内置命令来自 contracts，自定义命令来自当前会话；菜单与 /help 共用 */
export function useCommandCatalog(conn: HostConnection): CommandInfo[] {
  const [custom, setCustom] = useState<CommandInfo[]>([]);
  useEffect(() => {
    if (conn.status !== "ready") return;
    let cancelled = false;
    void conn
      .send("session/commands")
      .then((r) => {
        if (cancelled) return;
        const list = (r as { commands?: Array<{ name: string; source: string }> }).commands ?? [];
        setCustom(
          list.map((c) => ({
            name: c.name,
            desc: c.source === "project" ? "项目自定义命令" : "用户自定义命令",
            argsHint: "（自定义命令，支持 $ARGUMENTS）",
          })),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [conn.status, conn]);
  return [...BUILTIN_COMMANDS, ...custom];
}

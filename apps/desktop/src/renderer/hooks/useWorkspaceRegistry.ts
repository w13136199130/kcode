import { useEffect, useState } from "react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";
import {
  KNOWN_WORKSPACES,
  loadKnown,
  normalizePath,
  type Workspace,
  type WorkspaceSummary,
} from "../components/desktop-sidebar-model.js";

/**
 * 工作区注册/信任（D3-Host-01）。
 * 注册表在 host；UI 不再把工作区写 localStorage，只在首次启动迁移旧键。
 */
export function useWorkspaceRegistry(options: {
  conn: HostConnection;
  currentWorkspace: string;
}): {
  registered: WorkspaceSummary[];
  trusted: Record<string, boolean>;
  notice: string;
  setNotice(value: string): void;
  addWorkspace(): Promise<{ path: string; trusted: boolean } | null>;
  trustWorkspace(workspace: Workspace): Promise<void>;
  removeWorkspace(workspace: Workspace): Promise<boolean>;
} {
  const { conn, currentWorkspace } = options;
  const [registered, setRegistered] = useState<WorkspaceSummary[]>([]);
  const [trusted, setTrusted] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (notice === "") return;
    const timer = window.setTimeout(() => setNotice(""), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (conn.status !== "ready") return;
    const send = conn.send;
    let cancelled = false;
    void (async () => {
      try {
        const result = (await send("workspace/list")) as { workspaces?: WorkspaceSummary[] };
        if (cancelled) return;
        const list = result.workspaces ?? [];
        const currentKey = normalizePath(currentWorkspace);
        const legacy = loadKnown().filter((path) => normalizePath(path) !== currentKey);
        const added: WorkspaceSummary[] = [];
        for (const path of legacy) {
          try {
            const response = (await send("workspace/add", { path })) as { workspace: WorkspaceSummary };
            added.push(response.workspace);
          } catch {
            // 单个旧路径迁移失败不阻断启动。
          }
        }
        if (cancelled) return;
        const merged = [...list, ...added].filter(
          (workspace, index, all) =>
            all.findIndex((item) => normalizePath(item.path) === normalizePath(workspace.path)) === index,
        );
        setRegistered(merged);
        setTrusted(
          Object.fromEntries(merged.map((workspace) => [normalizePath(workspace.path), workspace.trusted])),
        );
        if (legacy.length > 0) localStorage.removeItem(KNOWN_WORKSPACES);
      } catch {
        // 旧 host 不支持注册表时保持当前工作区；不把 UI 卡死。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conn.send, conn.status, currentWorkspace]);

  // 当前工作区可能不在注册表里（旧会话/默认 cwd），单独查询信任状态。
  useEffect(() => {
    if (conn.status !== "ready" || currentWorkspace === "") return;
    const key = normalizePath(currentWorkspace);
    void conn
      .send("workspace/status", { path: currentWorkspace })
      .then((result) => {
        const status = result as { trusted?: boolean };
        setTrusted((prev) => ({ ...prev, [key]: status.trusted === true }));
      })
      .catch(() => undefined);
  }, [conn.send, conn.status, currentWorkspace]);

  const register = (workspace: WorkspaceSummary): void => {
    const key = normalizePath(workspace.path);
    setRegistered((prev) => [workspace, ...prev.filter((item) => normalizePath(item.path) !== key)]);
    setTrusted((prev) => ({ ...prev, [key]: workspace.trusted }));
  };

  const addWorkspace = async (): Promise<{ path: string; trusted: boolean } | null> => {
    const dir = await window.kcodeHost?.pickDirectory();
    if (dir === null || dir === undefined || dir === "") return null;
    try {
      const response = (await conn.send("workspace/add", { path: dir })) as {
        workspace: WorkspaceSummary;
      };
      let workspace = response.workspace;
      register(workspace);
      if (!workspace.trusted && window.confirm("信任这个工作区？\n\n信任后新会话会加载 AGENTS.md、规则和项目级配置。")) {
        const result = (await conn.send("workspace/trust", { path: dir })) as { trusted?: boolean };
        workspace = { ...workspace, trusted: result.trusted === true };
        register(workspace);
      }
      setNotice(workspace.trusted ? "已添加并信任工作区" : "已添加工作区（未信任）");
      return { path: dir, trusted: workspace.trusted };
    } catch (error) {
      setNotice(`添加工作区失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const trustWorkspace = async (workspace: Workspace): Promise<void> => {
    try {
      await conn.send("workspace/trust", { path: workspace.path });
      setTrusted((prev) => ({ ...prev, [workspace.key]: true }));
      setNotice("已信任工作区；下一次新任务生效");
    } catch (error) {
      setNotice(`信任失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const removeWorkspace = async (workspace: Workspace): Promise<boolean> => {
    if (workspace.key === normalizePath(currentWorkspace)) {
      window.alert("不能从列表移除当前正在使用的工作区。");
      return false;
    }
    if (!window.confirm(`从工作区列表移除「${workspace.name}」？不会删除目录或任务。`)) return false;
    try {
      await conn.send("workspace/remove", { path: workspace.path });
      setRegistered((prev) => prev.filter((item) => normalizePath(item.path) !== workspace.key));
      return true;
    } catch (error) {
      setNotice(`移除失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  return { registered, trusted, notice, setNotice, addWorkspace, trustWorkspace, removeWorkspace };
}

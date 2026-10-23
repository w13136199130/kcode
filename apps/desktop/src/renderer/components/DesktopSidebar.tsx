import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowUpDown,
  ChevronDown,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";
import { TaskRow } from "./TaskRow.js";

/**
 * D3-UI Slice 1：桌面工作区/任务侧栏。
 *
 * 只使用现有 sessions/list / sessions/rename / sessions/delete 与窗口目录选择，
 * 不改 host 协议；尚未有 RPC 的项目归档/信任不在这里假装可用。
 */
interface SessionSummary {
  sessionId: string;
  preview: string;
  turns: number;
  modifiedAt?: number;
  workspaceKey?: string;
  title?: string;
}

interface Workspace {
  key: string;
  path: string;
  name: string;
  sessions: SessionSummary[];
  latest: number;
}

type VisibleWorkspace = Workspace & { visibleSessions: SessionSummary[] };

type SortMode = "recent" | "name";
type MenuState = { kind: "workspace" | "task"; key: string } | null;

const KNOWN_WORKSPACES = "kcode-desktop-workspaces";

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function pathName(value: string): string {
  const parts = value.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) ?? value;
}

function relativeTime(ts: number | undefined): string {
  if (ts === undefined) return "";
  const diff = Date.now() - ts;
  if (diff < 5 * 60_000) return "刚刚";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 365 * 24 * 60 * 60_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function loadKnown(): string[] {
  try {
    const raw = localStorage.getItem(KNOWN_WORKSPACES);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((item): item is string => typeof item === "string" && item.trim() !== ""))]
      : [];
  } catch {
    return [];
  }
}

export function DesktopSidebar(props: {
  conn: HostConnection;
  currentId: string | null;
  currentWorkspace: string;
  onOpen(sessionId: string, workspacePath: string): void;
  onNewSession(workspacePath: string): void;
  onOpenSettings(): void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [known, setKnown] = useState<string[]>(loadKnown);
  const [selected, setSelected] = useState(normalizePath(props.currentWorkspace));
  const [expanded, setExpanded] = useState<string | null>(normalizePath(props.currentWorkspace));
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [tasksOpen, setTasksOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [menu, setMenu] = useState<MenuState>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  // 当前主会话切换（打开任务/新建任务/切目录）后，侧栏跟随所选工作区。
  useEffect(() => {
    const key = normalizePath(props.currentWorkspace);
    if (key === "") return;
    setSelected(key);
    setExpanded(key);
    setKnown((prev) => (prev.some((item) => normalizePath(item) === key) ? prev : [...prev, props.currentWorkspace]));
  }, [props.currentWorkspace]);

  useEffect(() => {
    localStorage.setItem(KNOWN_WORKSPACES, JSON.stringify(known));
  }, [known]);

  useEffect(() => {
    if (props.conn.status !== "ready") return;
    const send = props.conn.send;
    let cancelled = false;
    const load = (): void => {
      void send("sessions/list")
        .then((result) => {
          if (cancelled) return;
          const list = result as { sessions?: SessionSummary[] };
          setSessions((list.sessions ?? []).slice(0, 200));
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [props.conn.send, props.conn.status, refreshKey]);

  const workspaces = useMemo(() => {
    const map = new Map<string, Workspace>();
    const ensure = (path: string): Workspace => {
      const key = normalizePath(path);
      let workspace = map.get(key);
      if (workspace === undefined) {
        workspace = { key, path, name: pathName(path), sessions: [], latest: 0 };
        map.set(key, workspace);
      } else if (path !== key) {
        workspace.path = path;
        workspace.name = pathName(path);
      }
      return workspace;
    };

    if (props.currentWorkspace !== "") ensure(props.currentWorkspace);
    for (const path of known) ensure(path);
    for (const session of sessions) {
      if (session.workspaceKey === undefined || session.workspaceKey === "") continue;
      ensure(session.workspaceKey).sessions.push(session);
    }
    for (const workspace of map.values()) {
      workspace.latest = workspace.sessions.reduce((latest, session) => Math.max(latest, session.modifiedAt ?? 0), 0);
    }
    return [...map.values()].sort((a, b) => {
      if (sortMode === "name") return a.name.localeCompare(b.name, "zh-CN");
      return b.latest - a.latest || a.name.localeCompare(b.name, "zh-CN");
    });
  }, [known, props.currentWorkspace, sessions, sortMode]);

  const q = query.trim().toLocaleLowerCase();
  const visibleWorkspaces: VisibleWorkspace[] = workspaces
    .map((workspace) => {
      const nameMatch = q === "" || workspace.name.toLocaleLowerCase().includes(q) || workspace.path.toLocaleLowerCase().includes(q);
      const visibleSessions = nameMatch
        ? workspace.sessions
        : workspace.sessions.filter((session) => {
            const text = (session.title ?? session.preview).toLocaleLowerCase();
            return text.includes(q);
          });
      return { ...workspace, visibleSessions };
    })
    .filter((workspace) => q === "" || workspace.visibleSessions.length > 0 || workspace.name.toLocaleLowerCase().includes(q) || workspace.path.toLocaleLowerCase().includes(q));

  const sortSessions = (items: SessionSummary[]): SessionSummary[] =>
    [...items].sort((a, b) => {
      if (sortMode === "name") {
        return (a.title ?? a.preview).localeCompare(b.title ?? b.preview, "zh-CN");
      }
      return (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0);
    });

  const allInbox = sessions.filter((session) => session.workspaceKey === undefined || session.workspaceKey === "");
  const inbox = sortSessions(
    allInbox.filter((session) => {
      if (q === "") return true;
      return (session.title ?? session.preview).toLocaleLowerCase().includes(q);
    }),
  );

  const selectedWorkspace = workspaces.find((workspace) => workspace.key === selected);
  const targetPath = selectedWorkspace?.path ?? props.currentWorkspace;

  const remember = (path: string): void => {
    setKnown((prev) => (prev.some((item) => normalizePath(item) === normalizePath(path)) ? prev : [...prev, path]));
  };

  const addWorkspace = async (): Promise<void> => {
    const dir = await window.kcodeHost?.pickDirectory();
    if (dir === null || dir === undefined || dir === "") return;
    remember(dir);
    setSelected(normalizePath(dir));
    setExpanded(normalizePath(dir));
    setProjectsOpen(true);
    props.onNewSession(dir);
  };

  const toggleProjectSection = (): void => {
    if (projectsOpen) {
      setProjectsOpen(false);
      return;
    }
    // 整体展开时只展开工作区行，不自动展开某个工作区的会话。
    setProjectsOpen(true);
    setExpanded(null);
  };

  const openWorkspace = (workspace: Workspace): void => {
    setSelected(workspace.key);
    setExpanded((prev) => (prev === workspace.key ? null : workspace.key));
    setMenu(null);
  };

  const startRename = (session: SessionSummary): void => {
    setEditingId(session.sessionId);
    setDraftTitle(session.title ?? session.preview);
    setMenu(null);
  };

  const saveTitle = async (sessionId: string): Promise<void> => {
    const title = draftTitle.trim();
    if (title === "") {
      setEditingId(null);
      return;
    }
    try {
      await props.conn.send("sessions/rename", { sessionId, title });
      setEditingId(null);
      setRefreshKey((value) => value + 1);
    } catch {
      // 保持编辑态，让用户重试。
    }
  };

  const removeSession = async (session: SessionSummary): Promise<void> => {
    if (session.sessionId === props.currentId) {
      window.alert("不能删除正在使用的会话，先切换到其他任务或新建任务。");
      return;
    }
    if (!window.confirm("删除这个任务？会话文件不可恢复。")) return;
    try {
      await props.conn.send("sessions/delete", { sessionId: session.sessionId });
      setMenu(null);
      setRefreshKey((value) => value + 1);
    } catch {
      // host 拒绝时保留现状，不做静默删除。
    }
  };

  const copyPath = async (path: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      // 剪贴板不可用时忽略；不伪造成功提示。
    }
    setMenu(null);
  };

  const renderSessions = (workspace: VisibleWorkspace): ReactNode => {
    const items = sortSessions(q === "" ? workspace.sessions : workspace.visibleSessions);
    return (
      <div className="d2-tasks">
        {items.map((session) => (
          <TaskRow
            key={session.sessionId}
            title={session.title ?? (session.preview === "" ? "（空会话）" : session.preview)}
            age={relativeTime(session.modifiedAt)}
            active={session.sessionId === props.currentId}
            menu={menu?.kind === "task" && menu.key === session.sessionId}
            editing={editingId === session.sessionId}
            draftTitle={draftTitle}
            onOpen={() => {
              setMenu(null);
              props.onOpen(session.sessionId, workspace.path);
            }}
            onMenu={(event) => {
              event.stopPropagation();
              setMenu({ kind: "task", key: session.sessionId });
            }}
            onDraft={setDraftTitle}
            onSave={() => void saveTitle(session.sessionId)}
            onCancel={() => setEditingId(null)}
            onRename={() => startRename(session)}
            onDelete={() => void removeSession(session)}
            canDelete={session.sessionId !== props.currentId}
          />
        ))}
      </div>
    );
  };

  return (
    <aside className="sidebar desktop-v2">
      <div className="d2-head">
        <span className="d2-logo" aria-hidden="true">k</span>
        <span className="d2-name">kcode</span>
        <span className="d2-local">本地</span>
      </div>
      <button
        type="button"
        className="d2-new"
        onClick={() => props.onNewSession(targetPath)}
        title="新建会话（Ctrl+N）"
      >
        <Plus size={15} strokeWidth={1.8} />
        <span>新建会话</span>
        <kbd>⌘N</kbd>
      </button>

      <div className="d2-scroll">
        <section className="d2-section">
          <div className="d2-section-head">
            <button type="button" className="d2-label" onClick={toggleProjectSection}>
              <span>工作区</span>
              <ChevronDown size={12} strokeWidth={2} className={projectsOpen ? "" : "d2-chevron-closed"} />
            </button>
            <div className="d2-controls">
              <button
                type="button"
                className={`d2-icon ${searchOpen ? "active" : ""}`}
                title="搜索工作区或任务"
                onClick={() => {
                  if (searchOpen) {
                    setSearchOpen(false);
                    setQuery("");
                  } else {
                    setSearchOpen(true);
                  }
                }}
              >
                <Search size={13} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className="d2-icon"
                title={sortMode === "recent" ? "按名称排序" : "按最近更新排序"}
                onClick={() => setSortMode((mode) => (mode === "recent" ? "name" : "recent"))}
              >
                <ArrowUpDown size={13} strokeWidth={1.8} />
              </button>
              <button type="button" className="d2-icon" title="添加工作区" onClick={() => void addWorkspace()}>
                <FolderPlus size={14} strokeWidth={1.8} />
              </button>
            </div>
          </div>

          {searchOpen ? (
            <div className="d2-search">
              <Search size={12} strokeWidth={1.8} />
              <input
                autoFocus
                value={query}
                placeholder="搜索工作区或任务"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setQuery("");
                    setSearchOpen(false);
                  }
                }}
              />
            </div>
          ) : null}

          {projectsOpen ? (
            <div className="d2-workspaces">
              {visibleWorkspaces.map((workspace) => {
                const isActive = workspace.key === selected;
                const isExpanded = expanded === workspace.key;
                return (
                  <div className="d2-project" key={workspace.key}>
                    <div
                      className={`d2-project-row ${isActive ? "active" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => openWorkspace(workspace)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openWorkspace(workspace);
                        }
                      }}
                    >
                      <Folder size={14} strokeWidth={1.7} className="d2-folder" />
                      <span className="d2-project-name">{workspace.name}</span>
                      <div className="d2-project-actions">
                        <button
                          type="button"
                          title="新建任务"
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelected(workspace.key);
                            setExpanded(workspace.key);
                            setMenu(null);
                            props.onNewSession(workspace.path);
                          }}
                        >
                          <Plus size={13} strokeWidth={1.8} />
                        </button>
                        <button
                          type="button"
                          title="工作区操作"
                          onClick={(event) => {
                            event.stopPropagation();
                            setMenu({ kind: "workspace", key: workspace.key });
                          }}
                        >
                          <MoreHorizontal size={14} strokeWidth={1.8} />
                        </button>
                      </div>
                    </div>
                    {menu?.kind === "workspace" && menu.key === workspace.key ? (
                      <div className="d2-menu d2-project-menu">
                        <button type="button" onClick={() => void copyPath(workspace.path)}>
                          复制工作区路径
                        </button>
                        <button type="button" onClick={() => {
                          setMenu(null);
                          props.onNewSession(workspace.path);
                        }}>
                          新建任务
                        </button>
                      </div>
                    ) : null}
                    {isExpanded ? renderSessions(workspace) : null}
                  </div>
                );
              })}
              {visibleWorkspaces.length === 0 && q !== "" ? <div className="d2-empty">没有匹配的工作区</div> : null}
            </div>
          ) : null}
        </section>

        <section className="d2-section d2-inbox">
          <div className="d2-section-head">
            <button type="button" className="d2-label" onClick={() => setTasksOpen((open) => !open)}>
              <span>任务</span>
              <ChevronDown size={12} strokeWidth={2} className={tasksOpen ? "" : "d2-chevron-closed"} />
            </button>
          </div>
          {tasksOpen ? (
            <div className="d2-inbox-list">
              {inbox.map((session) => (
                <TaskRow
                  key={session.sessionId}
                  title={session.title ?? (session.preview === "" ? "（空会话）" : session.preview)}
                  age={relativeTime(session.modifiedAt)}
                  active={session.sessionId === props.currentId}
                  menu={menu?.kind === "task" && menu.key === session.sessionId}
                  editing={editingId === session.sessionId}
                  draftTitle={draftTitle}
                  onOpen={() => {
                    setMenu(null);
                    props.onOpen(session.sessionId, props.currentWorkspace);
                  }}
                  onMenu={(event) => {
                    event.stopPropagation();
                    setMenu({ kind: "task", key: session.sessionId });
                  }}
                  onDraft={setDraftTitle}
                  onSave={() => void saveTitle(session.sessionId)}
                  onCancel={() => setEditingId(null)}
                  onRename={() => startRename(session)}
                  onDelete={() => void removeSession(session)}
                  canDelete={session.sessionId !== props.currentId}
                />
              ))}
              {inbox.length === 0 ? <div className="d2-empty">暂无未归类任务</div> : null}
            </div>
          ) : null}
        </section>
      </div>

      <div className="d2-foot">
        <button type="button" className="d2-settings" onClick={props.onOpenSettings}>
          <Settings size={14} strokeWidth={1.8} />
          <span>设置</span>
        </button>
      </div>
    </aside>
  );
}

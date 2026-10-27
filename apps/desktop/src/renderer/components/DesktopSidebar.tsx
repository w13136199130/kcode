import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpDown,
  ChevronDown,
  FolderPlus,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";
import { useWorkspaceRegistry } from "../hooks/useWorkspaceRegistry.js";
import { useSidebarSessions } from "../hooks/useSidebarSessions.js";
import { TaskList } from "./TaskList.js";
import { ArchivedTaskList } from "./ArchivedTaskList.js";
import { TrashTaskList } from "./TrashTaskList.js";
import { WorkspaceRow } from "./WorkspaceRow.js";
import {
  hasContent,
  normalizePath,
  pathName,
  workspaceOf,
  type SessionSummary,
  type SortMode,
  type VisibleWorkspace,
  type Workspace,
} from "./desktop-sidebar-model.js";
/**
 * D3-UI Slice 1：桌面工作区/任务侧栏。
 *
 * 只使用现有 sessions/list / sessions/rename / sessions/delete 与窗口目录选择，
 * 不改 host 协议；工作区/归档通过独立例外 RPC。
 */
type MenuState = { kind: "workspace" | "task"; key: string } | null;
const INBOX = "__kcode_inbox__";
export function DesktopSidebar(props: {
  conn: HostConnection;
  currentId: string | null;
  currentWorkspace: string;
  currentPreview: string;
  activityKey: number;
  sessionsSignal: number;
  onOpen(sessionId: string, workspacePath: string): void;
  onNewSession(workspacePath: string, opts?: { ungrouped?: boolean }): void;
  onOpenSettings(): void;
}) {
  const [selected, setSelected] = useState(normalizePath(props.currentWorkspace));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([normalizePath(props.currentWorkspace)]));
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("created");
  const [menu, setMenu] = useState<MenuState>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const { effectiveSessions, refreshSessions, hasMore, total, loadMore } = useSidebarSessions({
    conn: props.conn,
    currentId: props.currentId,
    currentWorkspace: props.currentWorkspace,
    currentPreview: props.currentPreview,
    activityKey: props.activityKey,
    sessionsSignal: props.sessionsSignal,
    query,
    currentUngrouped: selected === INBOX,
  });
  const {
    registered,
    trusted,
    notice,
    addWorkspace: registerWorkspace,
    trustWorkspace: trustRegisteredWorkspace,
    removeWorkspace: unregisterWorkspace,
  } = useWorkspaceRegistry({ conn: props.conn, currentWorkspace: props.currentWorkspace });
  // 当前主会话切换（打开任务/新建任务/切目录）后，侧栏跟随所选工作区。
  useEffect(() => {
    const key = normalizePath(props.currentWorkspace);
    if (key === "") return;
    setSelected(key);
    setExpanded((prev) => new Set(prev).add(key));
  }, [props.currentWorkspace]);
  const workspaces = useMemo(() => {
    const map = new Map<string, Workspace>();
    const registeredByKey = new Map(registered.map((item) => [normalizePath(item.path), item]));
    const ensure = (path: string, createdAt: number): Workspace => {
      const key = normalizePath(path);
      let workspace = map.get(key);
      if (workspace === undefined) {
        workspace = { key, path, name: pathName(path), sessions: [], createdAt };
        map.set(key, workspace);
      } else if (path !== key) {
        workspace.path = path;
        workspace.name = pathName(path);
      }
      if (createdAt > 0 && (workspace.createdAt === 0 || createdAt < workspace.createdAt)) {
        workspace.createdAt = createdAt;
      }
      return workspace;
    };
    if (props.currentWorkspace !== "") ensure(props.currentWorkspace, 0);
    for (const workspace of registered) ensure(workspace.path, workspace.createdAt);
    const currentKey = normalizePath(props.currentWorkspace);
    for (const session of effectiveSessions) {
      if (session.archived === true || session.deleted === true || session.ungrouped === true) continue;
      const ownKey = workspaceOf(session);
      // 只有“当前空草稿”才强制归到当前工作区；历史无 workspaceKey 会话留在“任务”，
      // 否则点击旧会话会看起来被搬进某个分组。
      const isCurrentDraft = session.sessionId === props.currentId && !hasContent(session);
      const key = ownKey === "" && isCurrentDraft ? currentKey : ownKey;
      if (key === "") continue;
      if (!hasContent(session) && session.draft !== true && session.sessionId !== props.currentId) continue;
      const path = key === currentKey && currentKey !== "" ? props.currentWorkspace : (session.workspaceKey ?? key);
      ensure(path, registeredByKey.get(key)?.createdAt ?? 0).sessions.push(session);
    }
    return [...map.values()].sort((a, b) => {
      if (sortMode === "name") return a.name.localeCompare(b.name, "zh-CN");
      return a.createdAt - b.createdAt || a.name.localeCompare(b.name, "zh-CN");
    });
  }, [effectiveSessions, registered, props.currentId, props.currentWorkspace, sortMode]);
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
  const hasCurrentWorkspace = normalizePath(props.currentWorkspace) !== "";
  const allInbox = effectiveSessions.filter(
    (session) =>
      session.archived !== true &&
      session.deleted !== true &&
      (session.ungrouped === true || workspaceOf(session) === "") &&
      !(session.ungrouped !== true && session.sessionId === props.currentId && hasCurrentWorkspace && !hasContent(session)) &&
      (hasContent(session) || session.draft === true || session.sessionId === props.currentId),
  );
  const inbox = sortSessions(
    allInbox.filter((session) => {
      if (q === "") return true;
      return (session.title ?? session.preview).toLocaleLowerCase().includes(q);
    }),
  );
  const archived = sortSessions(
    effectiveSessions.filter(
      (session) => session.archived === true && session.deleted !== true && hasContent(session),
    ),
  );
  const trash = sortSessions(effectiveSessions.filter((session) => session.deleted === true));
  const selectedWorkspace = workspaces.find((workspace) => workspace.key === selected);
  const targetPath = selected === INBOX ? props.currentWorkspace : (selectedWorkspace?.path ?? props.currentWorkspace);
  const addWorkspace = async (): Promise<void> => {
    const result = await registerWorkspace();
    if (result === null) return;
    const key = normalizePath(result.path);
    setSelected(key);
    setExpanded((prev) => new Set(prev).add(key));
    setProjectsOpen(true);
    props.onNewSession(result.path);
  };
  const trustWorkspace = async (workspace: Workspace): Promise<void> => {
    setMenu(null);
    await trustRegisteredWorkspace(workspace);
    window.dispatchEvent(new CustomEvent("kcode-workspace-trust", { detail: workspace.path }));
  };
  const removeWorkspace = async (workspace: Workspace): Promise<void> => {
    setMenu(null);
    const removed = await unregisterWorkspace(workspace);
    if (!removed) return;
    const currentKey = normalizePath(props.currentWorkspace);
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(workspace.key);
      return next;
    });
    if (selected === workspace.key) {
      setSelected(currentKey);
      setExpanded((prev) => new Set(prev).add(currentKey));
    }
  };
  const toggleProjectSection = (): void => {
    // 整体收起/展开只控制工作区行；各工作区的会话展开状态互不影响。
    setProjectsOpen((open) => !open);
  };
  const openWorkspace = (workspace: Workspace): void => {
    setSelected(workspace.key);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(workspace.key)) next.delete(workspace.key);
      else next.add(workspace.key);
      return next;
    });
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
      refreshSessions();
    } catch {
      // 保持编辑态，让用户重试。
    }
  };
  const removeSession = async (session: SessionSummary): Promise<void> => {
    if (session.sessionId === props.currentId) {
      window.alert("不能删除正在使用的会话，先切换到其他任务或新建任务。");
      return;
    }
    if (!window.confirm("把这个任务移到回收站？之后可以恢复。")) return;
    try {
      await props.conn.send("sessions/delete", { sessionId: session.sessionId });
      setMenu(null);
      refreshSessions();
    } catch {
      // host 拒绝时保留现状，不做静默删除。
    }
  };
  const restoreSession = async (session: SessionSummary): Promise<void> => {
    try {
      await props.conn.send("sessions/restore", { sessionId: session.sessionId });
      setMenu(null);
      refreshSessions();
    } catch (error) {
      window.alert(`恢复失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const emptyTrash = async (): Promise<void> => {
    if (!window.confirm("永久清空回收站？会话文件将被删除，无法恢复。")) return;
    try {
      await props.conn.send("sessions/empty_trash");
      setShowTrash(false);
      refreshSessions();
    } catch (error) {
      window.alert(`清空回收站失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const archiveSession = async (session: SessionSummary, archived: boolean): Promise<void> => {
    try {
      await props.conn.send("sessions/archive", { sessionId: session.sessionId, archived });
      setMenu(null);
      refreshSessions();
    } catch (error) {
      window.alert(`归档失败：${error instanceof Error ? error.message : String(error)}`);
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
  return (
    <aside className="sidebar desktop-v2">
      <div className="d2-head">
        <span className="d2-logo" aria-hidden="true">k</span>
        <span className="d2-name">kcode</span>
        <span className="d2-local">本地</span>
      </div>
      <button type="button" className="d2-new" onClick={() => props.onNewSession(targetPath, { ungrouped: selected === INBOX })} title="新建会话（Ctrl+N）">
        <Plus size={15} strokeWidth={1.8} />
        <span>新建会话</span>
        <kbd>⌘N</kbd>
      </button>
      {notice !== "" ? <div className="d2-notice" role="status">{notice}</div> : null}
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
                title={sortMode === "created" ? "按名称排序" : "按创建顺序排序"}
                onClick={() => setSortMode((mode) => (mode === "created" ? "name" : "created"))}
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
                const isExpanded = expanded.has(workspace.key);
                const isTrusted = trusted[workspace.key] === true;
                return (
                  <WorkspaceRow
                    key={workspace.key}
                    workspace={workspace}
                    active={isActive}
                    expanded={isExpanded}
                    trusted={isTrusted}
                    menuOpen={menu?.kind === "workspace" && menu.key === workspace.key}
                    current={workspace.key === normalizePath(props.currentWorkspace)}
                    onOpen={() => openWorkspace(workspace)}
                    onNew={() => {
                      setSelected(workspace.key);
                      setExpanded((prev) => new Set(prev).add(workspace.key));
                      setMenu(null);
                      props.onNewSession(workspace.path);
                    }}
                    onMenu={(event) => {
                      event.stopPropagation();
                      setMenu({ kind: "workspace", key: workspace.key });
                    }}
                    onTrust={() => void trustWorkspace(workspace)}
                    onRemove={() => void removeWorkspace(workspace)}
                    onCopy={() => void copyPath(workspace.path)}
                  >
                    <TaskList
                      sessions={sortSessions(q === "" ? workspace.sessions : workspace.visibleSessions)}
                      currentId={props.currentId}
                      menuKey={menu?.kind === "task" ? menu.key : null}
                      editingId={editingId}
                      draftTitle={draftTitle}
                      emptyText={q === "" ? "暂无任务" : "没有匹配任务"}
                      archived={false}
                      onOpen={(session) => {
                        setMenu(null);
                        props.onOpen(session.sessionId, workspace.path);
                      }}
                      onMenu={(session, event) => {
                        event.stopPropagation();
                        setMenu({ kind: "task", key: session.sessionId });
                      }}
                      onDraft={setDraftTitle}
                      onSave={(sessionId) => void saveTitle(sessionId)}
                      onCancel={() => setEditingId(null)}
                      onRename={startRename}
                      onDelete={(session) => void removeSession(session)}
                      onArchive={(session, archived) => void archiveSession(session, archived)}
                    />
                  </WorkspaceRow>
                );
              })}
              {visibleWorkspaces.length === 0 && q !== "" ? <div className="d2-empty">没有匹配的工作区</div> : null}
            </div>
          ) : null}
        </section>
        <section className="d2-section d2-inbox">
          <div className="d2-section-head">
            <button
              type="button"
              className={`d2-label ${selected === INBOX ? "active" : ""}`}
              onClick={() => {
                setSelected(INBOX);
                setTasksOpen((open) => !open);
                setMenu(null);
              }}
            >
              <span>任务</span>
              <ChevronDown size={12} strokeWidth={2} className={tasksOpen ? "" : "d2-chevron-closed"} />
            </button>
          </div>
          {tasksOpen || q !== "" ? (
            <TaskList
              sessions={inbox}
              currentId={props.currentId}
              menuKey={menu?.kind === "task" ? menu.key : null}
              editingId={editingId}
              draftTitle={draftTitle}
              emptyText="暂无未归类任务"
              archived={false}
              onOpen={(session) => {
                setMenu(null);
                props.onOpen(session.sessionId, props.currentWorkspace);
              }}
              onMenu={(session, event) => {
                event.stopPropagation();
                setMenu({ kind: "task", key: session.sessionId });
              }}
              onDraft={setDraftTitle}
              onSave={(sessionId) => void saveTitle(sessionId)}
              onCancel={() => setEditingId(null)}
              onRename={startRename}
              onDelete={(session) => void removeSession(session)}
              onArchive={(session, archived) => void archiveSession(session, archived)}
            />
          ) : null}
        </section>
        {archived.length > 0 ? (
          <ArchivedTaskList
            sessions={archived}
            open={showArchived}
            onToggle={() => setShowArchived((open) => !open)}
            currentId={props.currentId}
            menuKey={menu?.kind === "task" ? menu.key : null}
            editingId={editingId}
            draftTitle={draftTitle}
            onOpen={(session) => {
              setMenu(null);
              props.onOpen(session.sessionId, session.workspaceKey || props.currentWorkspace);
            }}
            onMenu={(session, event) => {
              event.stopPropagation();
              setMenu({ kind: "task", key: session.sessionId });
            }}
            onDraft={setDraftTitle}
            onSave={(sessionId) => void saveTitle(sessionId)}
            onCancel={() => setEditingId(null)}
            onRename={startRename}
            onDelete={(session) => void removeSession(session)}
            onArchive={(session) => void archiveSession(session, false)}
          />
        ) : null}
        {trash.length > 0 ? (
          <TrashTaskList
            sessions={trash}
            open={showTrash}
            onToggle={() => setShowTrash((open) => !open)}
            currentId={props.currentId}
            menuKey={menu?.kind === "task" ? menu.key : null}
            onOpen={(session) => {
              setMenu(null);
              props.onOpen(session.sessionId, session.workspaceKey || props.currentWorkspace);
            }}
            onMenu={(session, event) => {
              event.stopPropagation();
              setMenu({ kind: "task", key: session.sessionId });
            }}
            onRestore={(session) => void restoreSession(session)}
            onEmpty={() => void emptyTrash()}
          />
        ) : null}
        {hasMore ? (
          <button type="button" className="d2-load-more" onClick={loadMore}>加载更多（{effectiveSessions.length}/{total}）</button>
        ) : null}
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
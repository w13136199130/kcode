/* kcode desktop UI prototype — state + interactions.
   No framework, no network. Designed to be opened directly from the file system. */

const params = new URLSearchParams(window.location.search);
const html = document.documentElement;
const body = document.body;
const app = document.getElementById("app");
const toast = document.getElementById("toast");
const composer = document.getElementById("composer-input");
const paletteInput = document.getElementById("palette-input");
const menuLayer = document.getElementById("menu-layer");
const menuTitle = document.getElementById("menu-title");
const menuItems = document.getElementById("menu-items");
const dialogOverlay = document.getElementById("dialog-overlay");
const dialogTitle = document.getElementById("dialog-title");
const dialogDesc = document.getElementById("dialog-desc");
const dialogBody = document.getElementById("dialog-body");
const dialogFoot = document.getElementById("dialog-foot");
const queueBar = document.getElementById("queue-bar");
const queueCount = document.getElementById("queue-count");
const attachmentRow = document.getElementById("attachment-row");
const folderPicker = document.getElementById("workspace-folder-picker");

const state = {
  screen: params.get("screen") || "conversation",
  theme: params.get("theme") === "dark" ? "dark" : "light",
  present: params.get("present") === "1",
  settings: "models",
  busy: false,
  queue: 0,
  attachments: [],
  mode: "变更确认",
  model: "GLM-5.3",
  workspace: "kcode",
  workspacePath: "E:\\space\\my_space\\MyProject\\kcode",
  trusted: new Set(["web"]),
};

let menuActions = [];
let dialogActions = [];
let busyTimer = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function writeQuery() {
  const next = new URLSearchParams();
  next.set("screen", state.screen);
  next.set("theme", state.theme);
  if (state.present) next.set("present", "1");
  try {
    window.history.replaceState(null, "", `${window.location.pathname}?${next.toString()}`);
  } catch {
    // file:// 下部分浏览器禁止 replaceState；原型不依赖 URL 持久化
  }
}

function setTheme(theme) {
  state.theme = theme === "dark" ? "dark" : "light";
  html.dataset.theme = state.theme;
  document.querySelectorAll(".theme-choice").forEach((button) => {
    button.classList.toggle("active", button.dataset.themeChoice === state.theme);
  });
  const icon = document.querySelector('[data-action="toggle-theme"] .icon use');
  if (icon) icon.setAttribute("href", state.theme === "dark" ? "#i-sun" : "#i-moon");
  writeQuery();
}

function setPresent(present) {
  state.present = present;
  body.classList.toggle("present", present);
  writeQuery();
}

function setScreen(screen) {
  state.screen = screen;
  body.dataset.screen = screen;
  app.classList.toggle("context-open", screen === "context");
  closeMenu(false);
  closeDialog(false);
  if (screen === "settings") openSettings(state.settings);
  if (screen === "palette") requestAnimationFrame(() => paletteInput?.focus());
  if (screen === "empty") {
    document.querySelectorAll(".session-item.active").forEach((item) => item.classList.remove("active"));
  }
  const title = document.getElementById("project-title");
  const activeSession = document.querySelector(".session-item.active")?.dataset.session;
  if (title) title.textContent = screen === "empty" ? "新会话" : activeSession ?? "新会话";
  syncProtoButtons();
  syncPrimaryNav();
  writeQuery();
}

function syncPrimaryNav() {
  const mainScreen = ["automation", "plugins"].includes(state.screen) ? state.screen : "conversation";
  document.querySelectorAll(".primary-nav-item[data-screen]").forEach((button) => {
    button.classList.toggle("active", button.dataset.screen === mainScreen);
  });
}

function syncTrust() {
  const trusted = state.workspace === "inbox" || state.workspace === "" || state.trusted.has(state.workspace);
  body.classList.toggle("workspace-trusted", trusted);
}

function updateWorkspaceUI() {
  document.querySelectorAll(".workspace-item.project-row").forEach((item) => {
    item.classList.toggle("active", item.dataset.workspace === state.workspace);
  });
  document.querySelector(".task-section-inbox")?.classList.toggle("active", state.workspace === "inbox");
  const pathName = document.getElementById("workspace-path-name");
  if (pathName) pathName.textContent = state.workspace === "inbox" ? "未归类" : state.workspace;
  document.querySelectorAll(".project-group").forEach((group) => {
    const count = group.querySelectorAll(".project-tasks .session-item").length;
    const badge = group.querySelector("[data-project-count]");
    if (badge) badge.textContent = String(count);
  });
  syncTrust();
}

function selectWorkspace(workspace) {
  const item = document.querySelector(`.workspace-item[data-workspace="${workspace}"]`);
  if (!item) return;
  const group = item.closest(".project-group");
  const wasActive = state.workspace === workspace;
  const willExpand = group?.classList.contains("collapsed") ?? false;
  document.getElementById("project-group")?.classList.remove("collapsed");
  if (group) {
    if (willExpand) {
      document.querySelectorAll(".project-group").forEach((node) => node.classList.add("collapsed"));
      group.classList.remove("collapsed");
    } else {
      group.classList.add("collapsed");
    }
  }
  state.workspace = workspace;
  state.workspacePath = item.dataset.path ?? "";
  document.querySelectorAll(".session-item.active").forEach((node) => node.classList.remove("active"));
  updateWorkspaceUI();
  if (!wasActive) setScreen("empty");
  showToast(`工作区：${workspace}${state.trusted.has(workspace) ? " · 已信任" : " · 待信任"}`);
}

function selectInbox() {
  state.workspace = "inbox";
  state.workspacePath = "";
  document.getElementById("inbox-group")?.classList.remove("collapsed");
  document.querySelectorAll(".session-item.active").forEach((node) => node.classList.remove("active"));
  updateWorkspaceUI();
  setScreen("empty");
  showToast("任务：未归类");
}

function toggleProjects() {
  const section = document.getElementById("project-group");
  if (!section) return;
  const expanding = section.classList.contains("collapsed");
  section.classList.toggle("collapsed");
  if (expanding) {
    document.querySelectorAll(".project-group").forEach((group) => group.classList.add("collapsed"));
  }
}

function toggleInbox() {
  const group = document.getElementById("inbox-group");
  if (!group) return;
  const expanding = group.classList.contains("collapsed");
  group.classList.toggle("collapsed");
  if (expanding) {
    state.workspace = "inbox";
    state.workspacePath = "";
    document.querySelectorAll(".session-item.active").forEach((node) => node.classList.remove("active"));
    updateWorkspaceUI();
    setScreen("empty");
  }
}

function openWorkspaceSwitcher(anchor) {
  const projects = [...document.querySelectorAll(".project-row")].map((row) => ({
    name: row.querySelector(".project-name")?.textContent ?? row.dataset.workspace,
    workspace: row.dataset.workspace,
  }));
  openMenu(anchor, "切换工作区", [
    ...projects.map((project) => ({
      label: project.name,
      desc: "工作区",
      icon: "i-folder",
      active: state.workspace === project.workspace,
      action: () => selectWorkspace(project.workspace),
    })),
    ...(projects.length > 0 ? [{ divider: true }] : []),
    { label: "添加项目", icon: "i-plus", action: () => pickWorkspaceFolder() },
    { label: "管理工作区", icon: "i-settings", action: () => openSettings("general") },
  ]);
}

function createWorkspace(name, path, trusted = false) {
  const slug = `ws-${Date.now()}`;
  if (trusted) state.trusted.add(slug);
  const group = document.createElement("div");
  group.className = "project-group";
  group.dataset.project = slug;
  group.innerHTML = `<div class="workspace-item project-row" data-action="select-workspace" data-workspace="${slug}" data-path="${escapeHtml(path)}" role="button" tabindex="0"><span class="project-folder"><svg class="icon"><use href="#i-folder" /></svg></span><span class="project-name">${escapeHtml(name)}</span><div class="project-actions"><button class="project-more" data-action="project-menu" data-workspace="${slug}" data-project-name="${escapeHtml(name)}" title="项目操作"><svg class="icon"><use href="#i-more" /></svg></button><button class="project-panel" data-action="project-panel" data-workspace="${slug}" title="项目面板"><svg class="icon"><use href="#i-task" /></svg></button><button class="project-new" data-action="new-task-in-project" data-workspace="${slug}" title="新建任务"><svg class="icon"><use href="#i-plus" /></svg></button></div></div><div class="project-tasks" id="task-list-${slug}"></div>`;
  document.getElementById("project-list")?.append(group);
  selectWorkspace(slug);
  return slug;
}

function pickWorkspaceFolder() {
  if (!folderPicker) {
    addWorkspaceManual();
    return;
  }
  folderPicker.value = "";
  folderPicker.click();
}

function promptTrustWorkspace(slug, name) {
  openDialog(
    "信任这个工作区？",
    `后续新会话不会重复询问。信任后会加载 ${name} 的 AGENTS.md、规则与工作区配置。`,
    '<div class="trust-preview"><span class="trust-preview-icon"><svg class="icon"><use href="#i-shield" /></svg></span><div><strong>只信任一次</strong><p>信任状态跟随工作区保存；随时可以在设置 → 权限里撤销。</p></div></div>',
    [
      { label: "稍后", action: () => closeDialog() },
      {
        label: "信任并打开",
        primary: true,
        action: () => {
          state.trusted.add(slug);
          syncTrust();
          closeDialog();
          showToast("工作区已信任；后续新会话不再询问");
        },
      },
    ],
  );
}

function addWorkspaceManual() {
  openDialog(
    "添加项目",
    "如果系统目录选择器不可用，可以直接输入目录；也可以从侧栏点“添加项目”选择本地文件夹。",
    `<label class="onboarding-field"><span>工作区名称</span><input id="workspace-name" placeholder="例如：kcode-web" /></label>
     <label class="onboarding-field"><span>项目目录</span><input id="workspace-path" placeholder="E:\\path\\to\\workspace" /></label>
     <label class="trust-check"><input id="workspace-trust" type="checkbox" checked /><span>信任此工作区并加载 AGENTS.md / 规则</span></label>`,
    [
      { label: "取消", action: () => closeDialog() },
      {
        label: "选择文件夹",
        action: () => {
          closeDialog();
          pickWorkspaceFolder();
        },
      },
      {
        label: "添加",
        primary: true,
        action: () => {
          const name = document.getElementById("workspace-name")?.value?.trim() || "新工作区";
          const path = document.getElementById("workspace-path")?.value?.trim() || "E:\\workspace";
          const trusted = Boolean(document.getElementById("workspace-trust")?.checked);
          closeDialog();
          createWorkspace(name, path, trusted);
        },
      },
    ],
  );
}

folderPicker?.addEventListener("change", () => {
  const file = folderPicker.files?.[0];
  if (!file) return;
  const relative = file.webkitRelativePath || file.name;
  const root = relative.split("/")[0] || "新工作区";
  // 浏览器目录选择只暴露相对路径；Electron 落产品时用 dialog.showOpenDialog 拿绝对路径
  const displayPath = `…/${root}`;
  createWorkspace(root, displayPath, false);
  promptTrustWorkspace(document.querySelector(".workspace-item.active")?.dataset.workspace ?? "", root);
  folderPicker.value = "";
});

window.__prototypeAddWorkspace = (name, path, trusted = false) => createWorkspace(name, path, trusted);
window.__prototypePromptTrust = (name = "api") => promptTrustWorkspace(document.querySelector(".workspace-item.active")?.dataset.workspace ?? "", name);

function syncProtoButtons() {
  document.querySelectorAll(".proto-btn[data-screen]").forEach((button) => {
    button.classList.toggle("active", button.dataset.screen === state.screen);
  });
}

function openSettings(tab = "models") {
  state.screen = "settings";
  body.dataset.screen = "settings";
  app.classList.remove("context-open");
  state.settings = tab;
  const titles = {
    general: ["常规", "语言、界面模式、终端与网络代理。"],
    appearance: ["外观", "主题、字号、密度与代码预览。"],
    models: ["模型设置", "选择默认模型，配置 provider 与本地密钥引用。"],
    permissions: ["权限", "默认审批级别与项目信任。"],
    browser: ["浏览器控制", "内置浏览器开关、证书与数据清理。"],
    shortcuts: ["键盘快捷键", "查看与恢复全局快捷键。"],
    memory: ["记忆", "工作区长期上下文与记忆文件。"],
    subagents: ["子智能体", "内置与自定义子智能体配置。"],
    plugins: ["插件", "安装、启停、移除本地插件。"],
    mcp: ["MCP 服务器", "项目级 MCP 连接与工具。"],
    skills: ["技能", "可复用工作流与本地技能包。"],
    commands: ["命令", "项目命令与快捷入口。"],
    hooks: ["钩子", "在任务生命周期事件中运行命令。"],
    usage: ["使用统计", "Token、模型用量与连续使用。"],
    archive: ["归档管理", "保留策略与已归档会话。"],
    about: ["关于", "版本与运行环境。"],
  };
  const [title, desc] = titles[tab] ?? titles.models;
  const titleNode = document.getElementById("settings-title");
  const descNode = document.getElementById("settings-desc");
  if (titleNode) titleNode.textContent = title;
  if (descNode) descNode.textContent = desc;
  document.querySelectorAll(".settings-nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.settings === tab);
  });
  document.querySelectorAll(".settings-panel").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.settingsPanel !== tab);
  });
  document.querySelectorAll(".model-only").forEach((item) => {
    item.classList.toggle("hidden", tab !== "models");
  });
  if (tab === "subagents") showSettingsSubview("subagents", "subagents-list");
  if (tab === "mcp") showSettingsSubview("mcp", "mcp-list");
  if (tab === "commands") showSettingsSubview("commands", "commands-list");
  if (tab === "hooks") showSettingsSubview("hooks", "hooks-list");
  syncProtoButtons();
}

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 1800);
}

/* ---------- generic menu ---------- */
function openMenu(anchor, title, items) {
  if (!anchor || !menuLayer) return;
  menuTitle.textContent = title;
  menuActions = [];
  let actionIndex = 0;
  menuItems.innerHTML = items
    .map((item) => {
      if (item.divider) return '<div class="menu-divider"></div>';
      const index = actionIndex++;
      menuActions.push(item.action);
      return `<button class="menu-item ${item.danger ? "danger" : ""} ${item.active ? "active" : ""}" data-menu-index="${index}">
        ${item.icon ? `<svg class="icon"><use href="#${item.icon}" /></svg>` : ""}
        <span>${escapeHtml(item.label)}${item.desc ? `<span class="menu-desc">${escapeHtml(item.desc)}</span>` : ""}</span>
        ${item.active ? '<span class="menu-check">✓</span>' : item.hint ? `<span class="menu-key">${escapeHtml(item.hint)}</span>` : ""}
      </button>`;
    })
    .join("");
  menuLayer.classList.add("open");
  const menu = menuLayer.querySelector(".menu");
  const positionAnchor = anchor.closest(".project-row, .session-item, .provider-row, .model-row, .list-card") ?? anchor;
  menu.style.left = "8px";
  menu.style.top = "8px";
  requestAnimationFrame(() => {
    const rect = positionAnchor.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - size.width - 8);
    let top = rect.bottom + 6;
    if (top + size.height > window.innerHeight - 8) top = Math.max(46, rect.top - size.height - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top - 38}px`;
  });
}

function closeMenu(clear = true) {
  menuLayer?.classList.remove("open");
  if (clear) menuActions = [];
}

/* ---------- generic dialog ---------- */
function openDialog(title, desc, bodyHtml, actions) {
  dialogTitle.textContent = title;
  dialogDesc.textContent = desc || "";
  dialogBody.innerHTML = bodyHtml;
  dialogActions = actions;
  dialogFoot.innerHTML = actions
    .map(
      (action, index) =>
        `<button class="${action.primary ? "primary-btn" : "ghost-btn"} ${action.danger ? "danger" : ""}" data-dialog-index="${index}">${escapeHtml(action.label)}</button>`,
    )
    .join("");
  dialogOverlay.classList.add("open");
}

function closeDialog(clear = true) {
  dialogOverlay?.classList.remove("open");
  if (clear) dialogActions = [];
}

/* ---------- composer / queue ---------- */
function renderAttachments() {
  if (!attachmentRow) return;
  attachmentRow.classList.toggle("hidden", state.attachments.length === 0);
  attachmentRow.innerHTML = state.attachments
    .map(
      (name, index) =>
        `<span class="attachment-chip"><svg class="icon"><use href="#i-paperclip" /></svg>${escapeHtml(name)}<button data-remove-attachment="${index}" aria-label="移除附件"><svg class="icon"><use href="#i-close" /></svg></button></span>`,
    )
    .join("");
}

function renderQueue() {
  if (!queueBar) return;
  queueBar.classList.toggle("hidden", state.queue === 0);
  if (queueCount) queueCount.textContent = String(state.queue);
}

function setBusy(busy) {
  state.busy = busy;
  const stop = document.getElementById("composer-stop");
  const send = document.getElementById("send-btn");
  stop?.classList.toggle("hidden", !busy);
  send?.classList.toggle("hidden", busy);
  if (composer) {
    composer.placeholder = busy ? "运行中，Enter 加入队列…" : "描述任务，Enter 发送 · Shift+Enter 换行";
  }
  const live = document.querySelector(".thread-live");
  if (live) live.innerHTML = busy ? '<span class="status-dot running"></span>运行中' : '<span class="status-dot"></span>已连接';
  if (busy) {
    window.clearTimeout(busyTimer);
    busyTimer = window.setTimeout(() => {
      setBusy(false);
      showToast("本轮完成");
      if (state.queue > 0) {
        state.queue -= 1;
        renderQueue();
        window.setTimeout(() => setBusy(true), 280);
      }
    }, 2600);
  } else {
    window.clearTimeout(busyTimer);
  }
}

function appendUserMessage(text) {
  const thread = document.querySelector(".thread");
  if (!thread) return;
  const node = document.createElement("div");
  node.className = "message user-message";
  const bubble = document.createElement("div");
  bubble.className = "user-bubble";
  bubble.textContent = text;
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = "刚刚 · 你";
  node.append(bubble, meta);
  thread.append(node);
  document.getElementById("conversation-view")?.scrollTo({ top: 99999, behavior: "smooth" });
}

function taskListFor(workspace) {
  if (!workspace || workspace === "inbox") return document.getElementById("ungrouped-task-list");
  return document.getElementById(`task-list-${workspace}`) ?? document.getElementById("ungrouped-task-list");
}

function addSession(text, workspace = state.workspace, draft = false) {
  const list = taskListFor(workspace);
  if (!list) return;
  document.querySelectorAll(".session-item").forEach((item) => item.classList.remove("active"));
  const button = document.createElement("button");
  button.className = "session-item active";
  button.dataset.action = "open-session";
  button.dataset.workspace = workspace || "inbox";
  button.dataset.session = text.slice(0, 40) || "新任务";
  if (draft) button.dataset.draft = "true";
  button.innerHTML = `<span class="session-title">${escapeHtml(text.slice(0, 32) || "新任务")}</span><span class="session-age">刚刚</span><span class="session-more" data-action="session-menu" title="更多操作"><svg class="icon"><use href="#i-more" /></svg></span>`;
  list.prepend(button);
  document.getElementById("project-title").textContent = button.dataset.session;
  updateWorkspaceUI();
  return button;
}

function send() {
  const text = composer?.value.trim() ?? "";
  if (text === "") {
    showToast("先写一句任务描述");
    composer?.focus();
    return;
  }
  if (state.busy) {
    state.queue += 1;
    renderQueue();
    showToast(`已加入队列（第 ${state.queue} 条）`);
  } else {
    if (body.dataset.screen === "empty") {
      const active = document.querySelector(".session-item.active");
      if (active?.dataset.draft) {
        active.dataset.session = text.slice(0, 40);
        active.querySelector(".session-title").textContent = text.slice(0, 32);
        delete active.dataset.draft;
        document.getElementById("project-title").textContent = active.dataset.session;
      } else {
        addSession(text);
      }
      setScreen("conversation");
    }
    appendUserMessage(text);
    setBusy(true);
    showToast("已发送，kcode 开始工作");
  }
  if (composer) {
    composer.value = "";
    composer.style.height = "24px";
  }
}

function autoResize() {
  if (!composer) return;
  composer.style.height = "24px";
  composer.style.height = `${Math.min(120, composer.scrollHeight)}px`;
}

/* ---------- menu builders ---------- */
function openWorkspaceMenu(anchor) {
  const items = [...document.querySelectorAll(".workspace-item")].map((item) => ({
    label: item.dataset.workspace,
    desc: state.trusted.has(item.dataset.workspace) ? "已信任" : "未信任 · 打开后需确认",
    icon: "i-folder",
    active: item.dataset.workspace === state.workspace,
    action: () => selectWorkspace(item.dataset.workspace),
  }));
  items.push(
    { divider: true },
    { label: "添加项目", icon: "i-plus", action: () => pickWorkspaceFolder() },
    { label: "手动输入目录", icon: "i-folder", action: () => addWorkspaceManual() },
    { label: "管理工作区", icon: "i-settings", action: () => openSettings() },
  );
  openMenu(anchor, "工作区", items);
}

function openProjectMenu(anchor, workspace, name) {
  openMenu(anchor, "工作区操作", [
    { label: "新建任务", icon: "i-plus", action: () => newTaskInProject(workspace) },
    { label: "在编辑器中打开", icon: "i-external", action: () => showToast("打开工作区目录（原型）") },
    { divider: true },
    { label: "归档工作区", icon: "i-folder", action: () => archiveProject(workspace, name) },
    { label: "删除工作区", icon: "i-trash", danger: true, action: () => deleteProject(workspace, name) },
  ]);
}

function newTaskInProject(workspace) {
  document.getElementById("project-group")?.classList.remove("collapsed");
  document.querySelectorAll(".project-group").forEach((group) => group.classList.add("collapsed"));
  document.querySelector(`.project-group[data-project="${workspace}"]`)?.classList.remove("collapsed");
  state.workspace = workspace;
  state.workspacePath = document.querySelector(`.workspace-item[data-workspace="${workspace}"]`)?.dataset.path ?? "";
  updateWorkspaceUI();
  addSession("新任务", workspace, true);
  setScreen("empty");
}

function archiveProject(workspace, name) {
  const group = document.querySelector(`.project-group[data-project="${workspace}"]`);
  if (!group) return;
  const wasActive = state.workspace === workspace;
  group.remove();
  if (wasActive) {
    state.workspace = "inbox";
    state.workspacePath = "";
    setScreen("empty");
  }
  updateWorkspaceUI();
  showToast(`已归档工作区：${name}`);
}

function deleteProject(workspace, name) {
  openDialog("删除工作区", `确定删除「${name}」及其任务列表？工作区目录不会被删除。`, "", [
    { label: "取消", action: () => closeDialog() },
    {
      label: "删除工作区",
      danger: true,
      action: () => {
        const group = document.querySelector(`.project-group[data-project="${workspace}"]`);
        const wasActive = state.workspace === workspace;
        group?.remove();
        if (wasActive) {
          state.workspace = "inbox";
          state.workspacePath = "";
          setScreen("empty");
        }
        updateWorkspaceUI();
        showToast(`已删除工作区：${name}`);
        closeDialog();
      },
    },
  ]);
}

function toggleProject(workspace) {
  document.querySelector(`.project-group[data-project="${workspace}"]`)?.classList.toggle("collapsed");
}

function openSessionMenu(anchor, name) {
  openMenu(anchor, "会话操作", [
    { label: "重命名", icon: "i-file", action: () => renameSession(name) },
    { label: "导出 JSONL", icon: "i-external", action: () => showToast("已导出 JSONL（原型）") },
    { label: "复制会话 ID", icon: "i-copy", action: () => showToast("sess_desktop_audit（原型）") },
    { divider: true },
    { label: "归档任务", icon: "i-folder", action: () => archiveSession(name) },
    { label: "删除任务", icon: "i-trash", danger: true, action: () => deleteSession(name) },
  ]);
}

function openMoreMenu(anchor) {
  openMenu(anchor, "更多", [
    { label: state.busy ? "结束当前运行" : "模拟运行中", icon: "i-play", action: () => setBusy(!state.busy) },
    { label: "复制会话 ID", icon: "i-copy", action: () => showToast("sess_desktop_audit（原型）") },
    { label: "导出会话", icon: "i-external", action: () => showToast("已导出会话（原型）") },
    { divider: true },
    { label: "打开设置", icon: "i-settings", hint: "⌘,", action: () => openSettings() },
    { label: "关于 kcode", icon: "i-clock", action: () => openSettings("about") },
  ]);
}

function openAttachMenu(anchor) {
  openMenu(anchor, "添加附件", [
    { label: "选择文件…", icon: "i-paperclip", action: () => addAttachment("plan.md") },
    { label: "粘贴图片", icon: "i-paperclip", action: () => addAttachment("screenshot.png") },
    { label: "最近文件", icon: "i-clock", action: () => addAttachment("notes.md") },
  ]);
}

function openModeMenu(anchor) {
  const modes = [
    ["只读", "只读模式"],
    ["变更确认", "每次写操作需确认"],
    ["自动编辑", "编辑免确认，命令仍确认"],
    ["完全访问", "全部工具直接执行"],
  ];
  openMenu(
    anchor,
    "权限模式",
    modes.map(([label, desc]) => ({
      label,
      desc,
      icon: "i-shield",
      active: state.mode === label,
      action: () => {
        state.mode = label;
        const modeLabel = document.getElementById("mode-label");
        if (modeLabel) modeLabel.textContent = label;
        showToast(`权限模式：${label}`);
      },
    })),
  );
}

function openModelMenu(anchor) {
  if (anchor?.classList.contains("model-select")) {
    openModelPopover(anchor);
    return;
  }
  const models = ["GLM-5.3", "DeepSeek V3.2", "Claude Sonnet 4.6"];
  openMenu(
    anchor,
    "选择模型",
    models.map((label) => ({
      label,
      desc: label === "GLM-5.3" ? "默认 · 128K 上下文" : "自定义 provider",
      icon: "i-spark",
      active: state.model === label,
      action: () => {
        state.model = label;
        const modelLabel = document.getElementById("model-label");
        if (modelLabel) modelLabel.textContent = label;
        showToast(`模型：${label}`);
      },
    })),
  );
}

function openModelPopover() {
  closeContextPopover();
  document.getElementById("model-popover")?.classList.add("open");
}

function closeModelPopover() {
  document.getElementById("model-popover")?.classList.remove("open");
}

function setModel(name) {
  state.model = name;
  const modelLabel = document.getElementById("model-label");
  if (modelLabel) modelLabel.textContent = name;
  document.querySelectorAll("[data-model-choice]").forEach((item) => {
    item.classList.toggle("active", item.dataset.modelChoice === name);
    const check = item.querySelector(".model-choice-check");
    if (check) check.style.visibility = item.dataset.modelChoice === name ? "visible" : "hidden";
  });
  showToast(`模型：${name}`);
}

function openContextPopover() {
  closeModelPopover();
  document.getElementById("context-popover")?.classList.add("open");
}

function closeContextPopover() {
  document.getElementById("context-popover")?.classList.remove("open");
}

function openSlashMenu(anchor) {
  openMenu(anchor, "命令", [
    { label: "/mode", desc: "切换权限模式", icon: "i-shield", action: () => insertComposer("/mode ") },
    { label: "/model", desc: "切换模型", icon: "i-spark", action: () => insertComposer("/model ") },
    { label: "/clear", desc: "开始新会话", icon: "i-plus", action: () => { setScreen("empty"); closeMenu(); } },
    { label: "/export", desc: "导出当前会话", icon: "i-external", action: () => { showToast("已导出会话（原型）"); closeMenu(); } },
    { label: "/queue", desc: "查看排队消息", icon: "i-clock", action: () => { showToast("队列：0 条（原型）"); closeMenu(); } },
    { label: "/help", desc: "查看全部命令", icon: "i-command", action: () => { openPalette(); closeMenu(); } },
  ]);
}

function openFileMenu(anchor) {
  openMenu(anchor, "引用文件", [
    { label: "src/main.tsx", desc: "apps/desktop", icon: "i-file", action: () => insertComposer("@apps/desktop/src/main.tsx ") },
    { label: "src/port.ts", desc: "apps/host", icon: "i-file", action: () => insertComposer("@apps/host/src/port.ts ") },
    { label: "CLAUDE.md", desc: "工作区", icon: "i-file", action: () => insertComposer("@CLAUDE.md ") },
  ]);
}

function insertComposer(value) {
  if (!composer) return;
  composer.value = `${composer.value}${value}`;
  composer.focus();
  closeMenu();
  autoResize();
}

function addAttachment(name) {
  if (!state.attachments.includes(name)) state.attachments.push(name);
  renderAttachments();
  closeMenu();
  showToast(`已添加附件：${name}`);
}

/* ---------- dialogs ---------- */
function openFolderDialog() {
  openDialog(
    "打开工作区",
    "输入或选择一个本地目录，作为当前会话的 cwd。",
    '<label class="onboarding-field"><span>目录</span><input id="dialog-folder" value="E:\\space\\my_space\\MyProject\\kcode" /></label>',
    [
      { label: "取消", action: () => closeDialog() },
      {
        label: "打开",
        primary: true,
        action: () => {
          showToast("已切换工作区（原型）");
          closeDialog();
        },
      },
    ],
  );
}

function renameSession(name) {
  openDialog(
    "重命名会话",
    "只修改标题，不改 JSONL 内容。",
    `<label class="onboarding-field"><span>标题</span><input id="dialog-session-title" value="${escapeHtml(name)}" /></label>`,
    [
      { label: "取消", action: () => closeDialog() },
      {
        label: "保存",
        primary: true,
        action: () => {
          const value = document.getElementById("dialog-session-title")?.value?.trim();
          if (value) {
            document.querySelectorAll(".session-item.active .session-title").forEach((node) => {
              node.textContent = value;
            });
            showToast("会话已重命名");
          }
          closeDialog();
        },
      },
    ],
  );
}

function archiveSession(name) {
  const item = [...document.querySelectorAll(".session-item")].find((entry) => entry.dataset.session === name);
  if (!item) return;
  const wasActive = item.classList.contains("active");
  item.remove();
  updateWorkspaceUI();
  if (wasActive) setScreen("empty");
  showToast(`已归档任务：${name}`);
}

function deleteSession(name) {
  openDialog("删除任务", `确定删除「${name}」？会话文件不可恢复。`, "", [
    { label: "取消", action: () => closeDialog() },
    {
      label: "删除",
      danger: true,
      action: () => {
        const item = [...document.querySelectorAll(".session-item")].find((entry) => entry.dataset.session === name);
        const wasActive = item?.classList.contains("active");
        item?.remove();
        updateWorkspaceUI();
        if (wasActive) setScreen("empty");
        showToast("任务已删除（原型）");
        closeDialog();
      },
    },
  ]);
}

function openTrustDialog() {
  openDialog("工作区信任", "信任后会加载 AGENTS.md、工作区规则、工作区级 MCP 配置。", "", [
    { label: "取消", action: () => closeDialog() },
    {
      label: "信任本工作区",
      primary: true,
      action: () => {
        document.querySelectorAll(".trust-banner").forEach((banner) => banner.remove());
        showToast("已信任本工作区（原型）");
        closeDialog();
      },
    },
  ]);
}

/* ---------- palette ---------- */
function runPalette(label) {
  const actions = {
    新建会话: () => setScreen("empty"),
    查看工作区变更: () => setScreen("context"),
    打开设置: () => openSettings(),
    切换模型: () => {
      setScreen("conversation");
      window.setTimeout(() => openModelMenu(document.querySelector('[data-action="open-model-menu"]')), 0);
    },
    "对比 apps 下 5 个应用": () => setScreen("conversation"),
    修复桌面宿主启动: () => setScreen("conversation"),
  };
  closePalette();
  (actions[label] ?? (() => showToast(`原型：${label}`)))();
}

function openPalette() {
  state.screen = "palette";
  body.dataset.screen = "palette";
  syncProtoButtons();
  requestAnimationFrame(() => paletteInput?.focus());
}

function closePalette() {
  if (state.screen === "palette") setScreen("conversation");
}

function filterPalette() {
  const query = (paletteInput?.value ?? "").trim().toLowerCase();
  document.querySelectorAll(".palette-item").forEach((item) => {
    const label = (item.dataset.palette ?? item.textContent ?? "").toLowerCase();
    item.classList.toggle("hidden", query !== "" && !label.includes(query));
  });
  document.querySelectorAll(".palette-group").forEach((group) => {
    const visible = [...group.querySelectorAll(".palette-item")].some((item) => !item.classList.contains("hidden"));
    group.classList.toggle("hidden", !visible);
  });
  document.querySelectorAll(".palette-item").forEach((item) => item.classList.remove("active"));
  document.querySelector(".palette-item:not(.hidden)")?.classList.add("active");
}

/* ---------- onboarding ---------- */
function setPreset(name) {
  document.querySelectorAll(".preset").forEach((button) => {
    button.classList.toggle("active", button.dataset.preset === name);
  });
  const provider = document.getElementById("onboarding-provider");
  const model = document.getElementById("onboarding-model");
  const base = document.getElementById("onboarding-baseurl");
  if (name === "DeepSeek") {
    if (provider) provider.value = "DeepSeek";
    if (model) model.value = "deepseek-chat";
    if (base) base.value = "https://api.deepseek.com/v1";
  } else if (name === "GLM") {
    if (provider) provider.value = "Z.ai";
    if (model) model.value = "glm-5.3";
    if (base) base.value = "https://api.z.ai/api/paas/v4";
  }
  showToast(`已选择预设：${name}`);
}

/* ---------- settings ---------- */
function addProvider() {
  const providers = [
    ["Z.ai", "Z"],
    ["BigModel", "B"],
    ["DeepSeek", "D"],
    ["OpenAI", "O"],
    ["Anthropic", "A"],
    ["Kimi", "K"],
    ["MiniMax", "M"],
    ["自定义", "+"],
  ];
  openDialog(
    "添加供应商",
    "选择预设，或创建自定义 OpenAI-compatible 端点。",
    `<div class="provider-picker">${providers
      .map(
        ([name, icon]) =>
          `<button class="provider-choice" data-provider-preset="${escapeHtml(name)}"><span class="provider-choice-icon">${escapeHtml(icon)}</span><span><strong>${escapeHtml(name)}</strong><small>${name === "自定义" ? "Base URL + 模型" : "预设端点"}</small></span><span class="menu-chevron">›</span></button>`,
      )
      .join("")}</div>`,
    [{ label: "取消", action: () => closeDialog() }],
  );
}

function openProviderForm(name = "自定义") {
  openDialog(
    `添加 ${name}`,
    "配置 API 端点。密钥只写入本机钥匙串。",
    `<label class="onboarding-field"><span>名称</span><input id="provider-name" value="${escapeHtml(name)}" /></label>
     <label class="onboarding-field"><span>Base URL</span><input id="provider-base" placeholder="https://api.example.com/v1" /></label>
     <label class="onboarding-field"><span>模型</span><input id="provider-model" placeholder="model-name" /></label>`,
    [
      { label: "返回", action: () => addProvider() },
      {
        label: "添加",
        primary: true,
        action: () => {
          const providerName = document.getElementById("provider-name")?.value?.trim();
          if (providerName) {
            const list = document.querySelector(".provider-row")?.parentElement;
            if (list) {
              const row = document.createElement("div");
              row.className = "provider-row";
              row.dataset.action = "select-provider";
              row.innerHTML = `<span class="provider-logo">${escapeHtml(providerName.slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(providerName)}</strong><span>openai-compatible · 自定义</span></div><span class="pill muted">未启用</span><button class="icon-btn" data-action="provider-menu"><svg class="icon"><use href="#i-more" /></svg></button>`;
              list.insertBefore(row, list.querySelector(".form-block"));
            }
            showToast(`已添加 Provider：${providerName}`);
          }
          closeDialog();
        },
      },
    ],
  );
}

const providerCatalog = {
  BigModel: {
    logo: "B",
    kind: "openai-compatible · api.bigmodel.cn",
    base: "https://open.bigmodel.cn/api/paas/v4",
    plan: "GLM Coding Pro",
    expiry: "到期 2027年1月15日",
    models: [
      ["GLM-5.3", "128K · 视觉", true],
      ["GLM-5.3-Flash", "128K · 视觉", true],
    ],
  },
  "Start Plan": {
    logo: "S",
    kind: "编码套餐 · 按量",
    base: "https://open.bigmodel.cn/api/paas/v4",
    plan: "GLM Coding Lite",
    expiry: "到期 2026年12月31日",
    models: [["GLM-4.7", "128K · 文本", true]],
  },
  DeepSeek: {
    logo: "D",
    kind: "deepseek-chat · api.deepseek.com",
    base: "https://api.deepseek.com/v1",
    plan: "API 余额",
    expiry: "按量计费",
    models: [
      ["DeepSeek V4 Pro", "128K · 视觉", true],
      ["DeepSeek V4", "64K · 文本", false],
    ],
  },
  Kimi: {
    logo: "K",
    kind: "moonshot · api.moonshot.cn",
    base: "https://api.moonshot.cn/v1",
    plan: "Kimi 会员",
    expiry: "到期 2026年11月30日",
    models: [
      ["kimi-k3", "256K · 视觉", true],
      ["kimi-k2.7-code", "262K · 视觉", true],
      ["kimi-k2.6", "262K · 视觉", false],
    ],
  },
  "Z.ai": {
    logo: "Z",
    kind: "openai-compatible · api.z.ai",
    base: "https://api.z.ai/api/paas/v4",
    plan: "Z.ai Coding Plan",
    expiry: "到期 2027年1月15日",
    models: [
      ["GLM-5.3", "128K · 视觉", true],
      ["GLM-5.3-Flash", "128K · 视觉", true],
    ],
  },
};

function ensureProviderRow(name, data) {
  let row = document.querySelector(`.model-provider-list .provider-row[data-provider="${CSS.escape(name)}"]`);
  if (row) return row;
  row = document.createElement("button");
  row.className = "provider-row";
  row.dataset.action = "select-provider";
  row.dataset.provider = name;
  row.innerHTML = `<span class="provider-logo">${escapeHtml(data.logo ?? name.slice(0, 1))}</span><div><strong>${escapeHtml(name)}</strong><span>${escapeHtml(data.kind ?? "自定义")}</span></div><span class="status-dot warn"></span>`;
  document.querySelector(".model-provider-list .provider-add-inline")?.before(row);
  return row;
}

function renderProviderDetail(name) {
  const data = providerCatalog[name] ?? {
    logo: name.slice(0, 1).toUpperCase(),
    kind: "自定义 · openai-compatible",
    base: "https://api.example.com/v1",
    plan: "自定义供应商",
    expiry: "未绑定套餐",
    models: [["model-name", "上下文", true]],
  };
  const detail = document.getElementById("provider-detail");
  const add = document.getElementById("provider-add");
  if (detail) detail.classList.remove("hidden");
  if (add) add.classList.add("hidden");
  document.querySelectorAll(".model-provider-list .provider-row").forEach((item) => {
    item.classList.toggle("active", item.dataset.provider === name);
  });
  const setText = (id, value) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  };
  setText("detail-logo", data.logo);
  setText("detail-name", name);
  setText("detail-kind", data.kind);
  setText("plan-name", data.plan);
  setText("plan-expiry", data.expiry);
  const base = document.getElementById("detail-base");
  if (base) base.value = data.base;
  const list = document.getElementById("model-list");
  if (list) {
    list.innerHTML = data.models
      .map(
        ([model, meta, enabled]) =>
          `<div class="model-row"><span class="model-avatar">${escapeHtml(model.slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(model)}</strong><span>${escapeHtml(meta)}</span></div><button class="icon-btn" data-action="model-menu"><svg class="icon"><use href="#i-more" /></svg></button><button class="toggle ${enabled ? "on" : ""}" data-action="toggle-setting"><span></span></button></div>`,
      )
      .join("");
  }
}

function selectProvider(name) {
  const data = providerCatalog[name] ?? { logo: name.slice(0, 1).toUpperCase(), kind: "自定义", models: [] };
  ensureProviderRow(name, data);
  renderProviderDetail(name);
}

function showProviderPicker() {
  document.getElementById("provider-detail")?.classList.add("hidden");
  document.getElementById("provider-add")?.classList.remove("hidden");
}

function closeProviderPicker() {
  document.getElementById("provider-add")?.classList.add("hidden");
  document.getElementById("provider-detail")?.classList.remove("hidden");
}

function applyProviderPreset(preset) {
  const map = {
    "BigModel Coding Plan": ["BigModel", "GLM Coding Pro"],
    "Z.ai Coding Plan": ["Z.ai", "Z.ai Coding Plan"],
    "BigModel API": ["BigModel", "BigModel API"],
    "Z.ai API": ["Z.ai", "Z.ai API"],
    Kimi: ["Kimi", "Kimi 会员"],
    MiniMax: ["MiniMax", "MiniMax API"],
    DeepSeek: ["DeepSeek", "API 余额"],
    OpenAI: ["OpenAI", "OpenAI API"],
    Anthropic: ["Anthropic", "Anthropic API"],
    "创建自定义供应商": ["自定义供应商", "自定义"],
  };
  const [name, plan] = map[preset] ?? [preset, "自定义"];
  if (!providerCatalog[name]) {
    providerCatalog[name] = {
      logo: name.slice(0, 1).toUpperCase(),
      kind: "openai-compatible · 自定义",
      base: "https://api.example.com/v1",
      plan,
      expiry: "未绑定套餐",
      models: [["model-name", "上下文", true]],
    };
  } else {
    providerCatalog[name].plan = plan;
  }
  selectProvider(name);
  showToast(`已添加供应商：${name}`);
}

function providerMenu(anchor, name) {  openMenu(anchor, name, [
    { label: "设为默认", icon: "i-check", action: () => showToast(`默认 Provider：${name}`) },
    { label: "编辑配置", icon: "i-settings", action: () => showToast("打开 Provider 编辑（原型）") },
    { divider: true },
    { label: "移除", icon: "i-trash", danger: true, action: () => showToast("已移除 Provider（原型）") },
  ]);
}

function pluginDialog() {
  openDialog(
    "安装插件",
    "输入 npm 包名或本地目录。安装前会做 manifest 校验。",
    '<label class="onboarding-field"><span>插件来源</span><input id="plugin-source" placeholder="npm 包名 / git URL / 本地目录" /></label>',
    [
      { label: "取消", action: () => closeDialog() },
      {
        label: "安装",
        primary: true,
        action: () => {
          showToast("插件已安装（原型）");
          closeDialog();
        },
      },
    ],
  );
}

/* ---------- events ---------- */
function showSettingsSubview(panel, subview) {
  document.querySelectorAll(`[data-settings-panel="${panel}"] .settings-subview`).forEach((view) => {
    view.classList.toggle("hidden", view.dataset.subview !== subview);
  });
}

function addSettingsListCard(panel, subview, name, meta, icon) {
  const container = document.querySelector(`[data-settings-panel="${panel}"] [data-subview="${subview}"]`);
  if (!container) return;
  const row = document.createElement("div");
  row.className = "list-card";
  row.innerHTML = `<span class="list-icon">${escapeHtml(icon ?? name.slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(name)}</strong><span>${escapeHtml(meta)}</span></div><span class="pill ok">已添加</span>`;
  const add = container.querySelector(".list-add");
  if (add) add.before(row);
  else container.append(row);
}

function startCreating(kind, prompt) {  setScreen("conversation");
  if (composer) {
    composer.value = prompt;
    autoResize();
    composer.focus();
  }
  showToast(`已进入会话：${kind}`);
}

function importMcpDialog() {
  openDialog(
    "导入外部 Agent MCP 服务器",
    "从本机已安装的 Agent 导入 MCP 配置。",
    `<div class="import-box"><label class="import-all"><input type="checkbox" /> 全选 <span class="muted">已选 0/1</span></label><div class="import-source"><span class="list-icon">C</span><div><strong>Codex CLI</strong><span>C:\\Users\\DELL\\.codex\\config.toml · 1 个 MCP 服务器</span></div><span class="menu-chevron">›</span></div></div>`,
    [
      { label: "取消", action: () => closeDialog() },
      { label: "导入到全局", primary: true, action: () => { closeDialog(); showToast("已导入 1 个 MCP 服务器（原型）"); } },
    ],
  );
}

function importSkillDialog() {
  openDialog(
    "导入外部 Agent 技能",
    "从本机已安装的 Agent 发现可导入技能。",
    `<div class="import-box"><label class="import-all"><input type="checkbox" /> 全选 <span class="muted">已选 0/5</span></label><div class="import-source"><span class="list-icon">C</span><div><strong>Codex CLI</strong><span>C:\\Users\\DELL\\.codex\\skills · 5 个技能</span></div><span class="menu-chevron">›</span></div></div>`,
    [
      { label: "取消", action: () => closeDialog() },
      { label: "导入到全局", primary: true, action: () => { closeDialog(); showToast("已导入 5 个技能（原型）"); } },
    ],
  );
}

function openPanelChoice(panel) {
  body.classList.remove("panel-picker-open");
  if (panel === "terminal") {
    body.classList.add("terminal-open");
    showToast("已打开终端");
    return;
  }
  if (panel === "files" || panel === "review") {
    setScreen("context");
    showToast(panel === "review" ? "已打开审查面板" : "已打开文件面板");
    return;
  }
  showToast("浏览器面板（原型）");
}

document.addEventListener("click", (event) => {
  const menuIndex = event.target.closest("[data-menu-index]")?.dataset.menuIndex;
  if (menuIndex !== undefined) {
    const action = menuActions[Number(menuIndex)];
    closeMenu();
    action?.();
    return;
  }

  if (event.target === menuLayer) {
    closeMenu();
    return;
  }

  const dialogIndex = event.target.closest("[data-dialog-index]")?.dataset.dialogIndex;
  if (dialogIndex !== undefined) {
    const action = dialogActions[Number(dialogIndex)];
    action?.action();
    return;
  }

  if (event.target === dialogOverlay) {
    closeDialog();
    return;
  }

  const removeAttachment = event.target.closest("[data-remove-attachment]")?.dataset.removeAttachment;
  if (removeAttachment !== undefined) {
    state.attachments.splice(Number(removeAttachment), 1);
    renderAttachments();
    return;
  }

  const preset = event.target.closest("[data-preset]");
  if (preset) {
    setPreset(preset.dataset.preset);
    return;
  }

  const providerPreset = event.target.closest("[data-provider-preset]");
  if (providerPreset) {
    if (providerPreset.closest("#provider-add")) {
      applyProviderPreset(providerPreset.dataset.providerPreset);
    } else {
      openProviderForm(providerPreset.dataset.providerPreset);
    }
    return;
  }

  const pluginTab = event.target.closest("[data-plugin-tab]");
  if (pluginTab) {
    document.querySelectorAll(".tab-pill").forEach((item) => item.classList.remove("active"));
    pluginTab.classList.add("active");
    showToast(`插件来源：${pluginTab.textContent}`);
    return;
  }

  const plan = event.target.closest("[data-plan]");
  if (plan) {
    showToast(`计划：${plan.dataset.plan === "approve" ? "已批准" : plan.dataset.plan === "revise" ? "待调整" : "已放弃"}`);
    setScreen("conversation");
    return;
  }

  const question = event.target.closest("[data-question]");
  if (question) {
    document.querySelectorAll(".question-option").forEach((item) => item.classList.remove("selected"));
    question.classList.add("selected");
    showToast("已选择，Enter 确认");
    return;
  }

  const approval = event.target.closest("[data-approval]");
  if (approval) {
    document.querySelectorAll(".approval-option").forEach((item) => item.classList.remove("selected"));
    approval.classList.add("selected");
    showToast(`已选择：${approval.querySelector("strong")?.textContent ?? "审批"}`);
    return;
  }

  const palette = event.target.closest("[data-palette]");
  if (palette) {
    runPalette(palette.dataset.palette);
    return;
  }

  const density = event.target.closest("[data-density]");
  if (density) {
    document.querySelectorAll("[data-density]").forEach((item) => item.classList.remove("active"));
    density.classList.add("active");
    showToast(`信息密度：${density.dataset.density === "compact" ? "紧凑" : "舒适"}`);
    return;
  }

  const font = event.target.closest("[data-font]");
  if (font) {
    document.querySelectorAll("[data-font]").forEach((item) => item.classList.remove("active"));
    font.classList.add("active");
    html.style.fontSize = `${font.dataset.font}px`;
    showToast(`界面字号：${font.dataset.font}px`);
    return;
  }

  const themeChoice = event.target.closest("[data-theme-choice]");
  if (themeChoice) {
    setTheme(themeChoice.dataset.themeChoice);
    return;
  }

  const settingsTab = event.target.closest("[data-settings]");
  if (settingsTab) {
    openSettings(settingsTab.dataset.settings);
    writeQuery();
    return;
  }

  const screen = event.target.closest(".proto-btn[data-screen], .primary-nav-item[data-screen]");
  if (screen) {
    setScreen(screen.dataset.screen);
    return;
  }

  const panelChoice = event.target.closest("[data-panel]");
  if (panelChoice) {
    openPanelChoice(panelChoice.dataset.panel);
    return;
  }

  const modelChoice = event.target.closest("[data-model-choice]");
  if (modelChoice) {
    setModel(modelChoice.dataset.modelChoice);
    closeModelPopover();
    return;
  }

  if (!event.target.closest(".composer-popover, [data-action='open-model-menu'], [data-action='open-context-meter']")) {
    closeModelPopover();
    closeContextPopover();
  }

  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) return;
  const action = actionTarget.dataset.action;

  switch (action) {
    case "toggle-panel":
      app.classList.remove("context-open");
      body.classList.toggle("panel-picker-open");
      break;
    case "close-panel-picker":
      body.classList.remove("panel-picker-open");
      break;
    case "toggle-terminal":
      app.classList.remove("context-open");
      body.classList.toggle("terminal-open");
      body.classList.remove("panel-picker-open");
      break;
    case "close-terminal":
      body.classList.remove("terminal-open");
      break;
    case "new-terminal":
      showToast("已新建终端标签（原型）");
      break;
    case "help-menu":
      openMenu(actionTarget, "帮助与支持", [
        { label: "产品文档", icon: "i-file", action: () => showToast("打开产品文档（原型）") },
        { label: "用户社群", icon: "i-chat", action: () => showToast("打开用户社群（原型）") },
        { label: "问题上报", icon: "i-external", action: () => showToast("打开问题上报（原型）") },
        { label: "提交漏洞", icon: "i-shield", action: () => showToast("打开漏洞提交（原型）") },
        { divider: true },
        { label: "导出日志", icon: "i-diff", action: () => showToast("日志已导出（原型）") },
        { label: "资源管理器", icon: "i-folder", action: () => showToast("打开资源管理器（原型）") },
        { label: "检查更新", icon: "i-refresh", action: () => showToast("当前已是最新版本") },
        { label: "关于 kcode", icon: "i-spark", action: () => openSettings("about") },
      ]);
      break;
    case "nav-back":
      showToast("后退（原型）");
      break;
    case "nav-forward":
      showToast("前进（原型）");
      break;
    case "toggle-theme":
      setTheme(state.theme === "dark" ? "light" : "dark");
      break;
    case "toggle-present":
      setPresent(!state.present);
      break;
    case "toggle-sidebar":
      app.classList.toggle("sidebar-collapsed");
      break;
    case "toggle-context":
      app.classList.toggle("context-open");
      showToast(app.classList.contains("context-open") ? "已打开变更" : "已收起变更");
      break;
    case "open-context-tasks":
      app.classList.add("context-open");
      document.querySelector('[data-context-tab="tasks"]')?.click();
      break;
    case "open-workspace-menu":
      openWorkspaceMenu(actionTarget);
      break;
    case "workspace-switcher":
      openWorkspaceSwitcher(actionTarget);
      break;
    case "add-workspace":
      pickWorkspaceFolder();
      break;
    case "select-workspace":
      selectWorkspace(actionTarget.dataset.workspace);
      break;
    case "select-inbox":
      selectInbox();
      break;
    case "toggle-projects":
      event.stopPropagation();
      toggleProjects();
      break;
    case "project-panel":
      showToast(`项目面板：${actionTarget.dataset.workspace}`);
      break;
    case "toggle-inbox":
      event.stopPropagation();
      toggleInbox();
      break;
    case "new-inbox-task":
      state.workspace = "inbox";
      state.workspacePath = "";
      document.getElementById("inbox-group")?.classList.remove("collapsed");
      addSession("新任务", "inbox", true);
      setScreen("empty");
      break;
    case "toggle-project":
      event.stopPropagation();
      toggleProject(actionTarget.dataset.project);
      break;
    case "new-task-in-project":
      newTaskInProject(actionTarget.dataset.workspace);
      break;
    case "project-menu":
      event.stopPropagation();
      openProjectMenu(actionTarget, actionTarget.dataset.workspace, actionTarget.dataset.projectName ?? actionTarget.dataset.workspace);
      break;
    case "task-search":
      openDialog("搜索任务", "输入任务标题或会话 ID。", '<label class="onboarding-field"><span>关键词</span><input placeholder="搜索任务..." /></label>', [
        { label: "取消", action: () => closeDialog() },
        { label: "搜索", primary: true, action: () => { closeDialog(); showToast("搜索任务（原型）"); } },
      ]);
      break;
    case "task-filter":
      openMenu(actionTarget, "筛选工作区", [
        { label: "全部工作区", icon: "i-folder", active: true, action: () => showToast("显示全部工作区") },
        { label: "已信任", icon: "i-shield", action: () => showToast("筛选：已信任") },
        { label: "待信任", icon: "i-lock", action: () => showToast("筛选：待信任") },
      ]);
      break;
    case "task-sort":
      openMenu(actionTarget, "任务排序", [
        { label: "最近更新", icon: "i-clock", active: true, action: () => showToast("按最近更新排序") },
        { label: "按工作区分组", icon: "i-folder", action: () => showToast("按工作区分组") },
        { label: "较早优先", icon: "i-arrow-up", action: () => showToast("按时间正序") },
      ]);
      break;
    case "open-session":
      document.querySelectorAll(".session-item").forEach((item) => item.classList.remove("active"));
      actionTarget.classList.add("active");
      state.workspace = actionTarget.dataset.workspace || "inbox";
      state.workspacePath = document.querySelector(`.workspace-item[data-workspace="${state.workspace}"]`)?.dataset.path ?? "";
      document.querySelector(`.project-group[data-project="${state.workspace}"]`)?.classList.remove("collapsed");
      if (state.workspace === "inbox") document.getElementById("inbox-group")?.classList.remove("collapsed");
      updateWorkspaceUI();
      document.getElementById("project-title").textContent = actionTarget.dataset.session;
      setScreen("conversation");
      showToast(`已打开：${actionTarget.dataset.session}`);
      break;
    case "session-menu":
      event.stopPropagation();
      openSessionMenu(actionTarget, actionTarget.closest(".session-item")?.dataset.session ?? "会话");
      break;
    case "new-chat":
      addSession("新任务", state.workspace || "inbox", true);
      setScreen("empty");
      break;
    case "open-palette":
      openPalette();
      break;
    case "open-settings":
      openSettings();
      writeQuery();
      break;
    case "open-more-menu":
      openMoreMenu(actionTarget);
      break;
    case "open-attach-menu":
      openAttachMenu(actionTarget);
      break;
    case "open-mode-menu":
      openModeMenu(actionTarget);
      break;
    case "open-model-menu":
      openModelMenu(actionTarget);
      break;
    case "close-model-popover":
      closeModelPopover();
      break;
    case "open-context-meter":
      openContextPopover();
      break;
    case "close-context-popover":
      closeContextPopover();
      break;
    case "open-approval":
      setScreen("approval");
      break;
    case "close-overlay":
      setScreen("conversation");
      break;
    case "close-menu":
      closeMenu();
      break;
    case "close-dialog":
      closeDialog();
      break;
    case "trust":
      state.trusted.add(state.workspace);
      syncTrust();
      showToast("工作区已信任；后续新会话不再重复询问");
      break;
    case "dismiss-trust":
      actionTarget.closest(".trust-banner")?.remove();
      break;
    case "show-rule":
      openDialog("权限规则", "当前规则：pnpm install 需要确认；写入 lockfile 属于工作区修改。", "", [
        { label: "关闭", primary: true, action: () => closeDialog() },
      ]);
      break;
    case "send":
      send();
      break;
    case "stop-run":
      setBusy(false);
      showToast("已停止当前运行（原型）");
      break;
    case "clear-queue":
      state.queue = 0;
      renderQueue();
      showToast("队列已清空");
      break;
    case "copy-answer":
      void navigator.clipboard?.writeText("kcode 的回复（原型）").catch(() => undefined);
      showToast("已复制回复");
      break;
    case "reset-quota":
      showToast("已申请重置额度（原型）");
      break;
    case "feedback":
      showToast("已打开反馈入口（原型）");
      break;
    case "dismiss-quota":
      actionTarget.closest(".quota-banner")?.remove();
      break;
    case "continue-task":
      setBusy(true);
      showToast("继续执行（原型）");
      break;
    case "retry-answer":
      appendUserMessage("重试上一条提问");
      setBusy(true);
      showToast("已重试（原型）");
      break;
    case "toggle-tool":
      actionTarget.closest(".tool-card")?.classList.toggle("expanded");
      break;
    case "select-file":
      document.querySelectorAll(".change-file").forEach((item) => item.classList.remove("active"));
      actionTarget.classList.add("active");
      const diffHead = document.querySelector(".diff-head > span:first-child");
      if (diffHead) diffHead.textContent = `apps/desktop/src/renderer/${actionTarget.dataset.file}`;
      showToast(`查看 ${actionTarget.dataset.file}`);
      break;
    case "open-editor":
      showToast("已在编辑器中打开（原型）");
      break;
    case "open-recent":
      setScreen("conversation");
      showToast(`已打开 ${actionTarget.dataset.session}（原型）`);
      break;
    case "add-provider":
      showProviderPicker();
      break;
    case "show-provider-picker":
      showProviderPicker();
      break;
    case "close-provider-picker":
      closeProviderPicker();
      break;
    case "provider-menu":
      event.stopPropagation();
      providerMenu(actionTarget, actionTarget.closest(".provider-row")?.dataset.provider ?? "供应商");
      break;
    case "select-provider":
      selectProvider(actionTarget.dataset.provider);
      break;
    case "add-model":
      openDialog("添加模型", "填写模型 ID 与显示名称。", '<label class="onboarding-field"><span>模型 ID</span><input placeholder="glm-5.3" /></label><label class="onboarding-field"><span>显示名称</span><input placeholder="GLM-5.3" /></label>', [
        { label: "取消", action: () => closeDialog() },
        { label: "添加", primary: true, action: () => { showToast("模型已添加（原型）"); closeDialog(); } },
      ]);
      break;
    case "model-menu":
      event.stopPropagation();
      openMenu(actionTarget, "模型", [
        { label: "设为默认", icon: "i-check", action: () => showToast("已设为默认模型") },
        { label: "编辑", icon: "i-settings", action: () => showToast("编辑模型（原型）") },
        { divider: true },
        { label: "移除", icon: "i-trash", danger: true, action: () => showToast("已移除模型（原型）") },
      ]);
      break;
    case "test-connection":
      showToast("连接成功（原型）");
      break;
    case "save-settings":
      showToast("配置已保存到本机（原型）");
      break;
    case "toggle-setting":
      actionTarget.classList.toggle("on");
      showToast(actionTarget.classList.contains("on") ? "已启用" : "已关闭");
      break;
    case "save-setting":
      showToast("已保存（原型）");
      break;
    case "clear-cache":
      showToast("缓存已清理（原型）");
      break;
    case "clear-browser":
      openDialog("清除全部浏览器数据", "Cookie、站点数据和缓存会被删除，此操作不可撤销。", "", [
        { label: "取消", action: () => closeDialog() },
        { label: "清除", danger: true, action: () => { showToast("浏览器数据已清除（原型）"); closeDialog(); } },
      ]);
      break;
    case "reset-shortcuts":
      showToast("快捷键已恢复默认");
      break;
    case "open-memory":
      showToast("打开记忆目录（原型）");
      break;
    case "edit-agent":
      showToast("编辑子智能体（原型）");
      break;
    case "open-subagent-form":
      showSettingsSubview("subagents", "subagents-form");
      break;
    case "close-subagent-form":
      showSettingsSubview("subagents", "subagents-list");
      break;
    case "save-subagent":
      addSettingsListCard("subagents", "subagents-list", document.querySelector('[data-subview="subagents-form"] .form-grid input')?.value?.trim() || "code-reviewer", "自定义子智能体 · 继承默认", "S");
      showSettingsSubview("subagents", "subagents-list");
      showToast("子智能体已保存（原型）");
      break;
    case "add-mcp":
      showSettingsSubview("mcp", "mcp-form");
      break;
    case "close-mcp-form":
      showSettingsSubview("mcp", "mcp-list");
      break;
    case "save-mcp":
      addSettingsListCard("mcp", "mcp-list", document.querySelector('[data-subview="mcp-form"] .form-grid input')?.value?.trim() || "new-mcp-server", "stdio · 本地 MCP server", "M");
      showSettingsSubview("mcp", "mcp-list");
      showToast("MCP 服务器已保存（原型）");
      break;
    case "import-mcp":
      importMcpDialog();
      break;
    case "new-skill":
      startCreating("技能", "使用 skill-creator 创建一个新技能：先问我技能名称、触发条件和输出格式，然后生成 SKILL.md。");
      break;
    case "add-skill":
      startCreating("技能", "使用 skill-creator 创建一个新技能，并说明它会提供哪些内置能力。");
      break;
    case "import-skill":
      importSkillDialog();
      break;
    case "edit-command":
      showSettingsSubview("commands", "commands-form");
      break;
    case "add-command":
      showSettingsSubview("commands", "commands-form");
      break;
    case "close-command-form":
      showSettingsSubview("commands", "commands-list");
      break;
    case "save-command":
      addSettingsListCard("commands", "commands-list", `/${document.querySelector('[data-subview="commands-form"] .field input')?.value?.trim() || "my-command"}`, ".kcode/commands/my-command.md", "/");
      showSettingsSubview("commands", "commands-list");
      showToast("命令已保存（原型）");
      break;
    case "add-hook":
      showSettingsSubview("hooks", "hooks-form");
      break;
    case "close-hook-form":
      showSettingsSubview("hooks", "hooks-list");
      break;
    case "save-hook":
      addSettingsListCard("hooks", "hooks-list", "PreToolUse 钩子", "进程 · Write, Edit, Bash", "H");
      showSettingsSubview("hooks", "hooks-list");
      showToast("钩子已保存（原型）");
      break;
    case "open-archive":
      showToast("打开归档列表（原型）");
      break;
    case "manage-trust":
      openTrustDialog();
      break;
    case "change-key":
      openDialog(
        "更换 API key",
        "新 key 只写入本机钥匙串，renderer 不会持有明文。",
        '<label class="onboarding-field"><span>API key</span><input id="dialog-key" type="password" placeholder="sk-..." /></label>',
        [
          { label: "取消", action: () => closeDialog() },
          { label: "保存", primary: true, action: () => { showToast("API key 已更新（原型）"); closeDialog(); } },
        ],
      );
      break;
    case "toggle-plugin": {
      const row = actionTarget.closest(".plugin-row");
      const pill = row?.querySelector(".pill");
      const enabled = actionTarget.textContent === "停用";
      if (pill) {
        pill.textContent = enabled ? "未启用" : "已启用";
        pill.className = `pill ${enabled ? "muted" : "ok"}`;
      }
      actionTarget.textContent = enabled ? "启用" : "停用";
      showToast(enabled ? "插件已停用" : "插件已启用");
      break;
    }
    case "remove-plugin":
      actionTarget.closest(".plugin-row")?.remove();
      showToast("插件已移除（原型）");
      break;
    case "add-plugin":
      startCreating("插件", "使用 plugin-creator 创建一个插件：先确认插件名称、要暴露的工具和触发方式，再生成插件目录与本地安装步骤。");
      break;
    case "onboarding-save":
      setScreen("conversation");
      showToast("配置已保存，开始工作");
      break;
    case "onboarding-skip":
      setScreen("conversation");
      showToast("已跳过引导（原型）");
      break;
    case "schedule-task":
      openDialog(
        "新建定时任务",
        "选择工作区与运行时间；定时任务会在后台执行。",
        '<label class="onboarding-field"><span>任务名称</span><input id="schedule-name" placeholder="例如：每日站会摘要" /></label><label class="onboarding-field"><span>运行时间</span><input id="schedule-time" value="每天 09:00" /></label>',
        [
          { label: "取消", action: () => closeDialog() },
          { label: "创建", primary: true, action: () => { showToast("定时任务已创建（原型）"); closeDialog(); } },
        ],
      );
      break;
    case "create-task":
      setScreen("empty");
      showToast("已创建临时任务");
      break;
    case "use-template":
      setScreen("conversation");
      if (composer) {
        composer.value = `按「${actionTarget.dataset.template}」模板执行，先给出步骤再开始。`;
        autoResize();
      }
      showToast(`已使用模板：${actionTarget.dataset.template}`);
      break;
    case "plugin-manage":
      openSettings("plugins");
      writeQuery();
      break;
    case "install-plugin": {
      const installed = actionTarget.textContent === "已安装";
      actionTarget.textContent = installed ? "已安装" : "已安装";
      actionTarget.classList.add("done");
      showToast(installed ? "插件已安装" : "插件安装完成（原型）");
      break;
    }
    case "pick-directory":
      openFolderDialog();
      break;
    default:
      showToast(`原型：${action}`);
  }
});

document.querySelectorAll("[data-context-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".context-tab").forEach((item) => item.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll("[data-context-panel]").forEach((panel) => {
      panel.classList.toggle("hidden", panel.dataset.contextPanel !== tab.dataset.contextTab);
    });
  });
});

composer?.addEventListener("input", () => {
  autoResize();
  if (composer.value === "/") openSlashMenu(composer);
  if (composer.value.endsWith("@")) openFileMenu(composer);
});
composer?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});

const reasoningRange = document.getElementById("reasoning-range");
const reasoningLevels = ["低", "中", "高"];

function setReasoning(index) {
  const level = reasoningLevels[index] ?? "高";
  const value = document.getElementById("reasoning-value");
  const badge = document.getElementById("reasoning-badge");
  if (value) value.textContent = level;
  if (badge) badge.textContent = level;
  if (reasoningRange) reasoningRange.value = String(index);
  showToast(`思考强度：${level}`);
}

reasoningRange?.addEventListener("input", () => {
  const level = reasoningLevels[Number(reasoningRange.value)] ?? "高";
  const value = document.getElementById("reasoning-value");
  const badge = document.getElementById("reasoning-badge");
  if (value) value.textContent = level;
  if (badge) badge.textContent = level;
});

paletteInput?.addEventListener("input", filterPalette);
paletteInput?.addEventListener("keydown", (event) => {
  const items = [...document.querySelectorAll(".palette-item:not(.hidden)")];
  const active = document.querySelector(".palette-item.active");
  const index = active ? items.indexOf(active) : -1;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    items[(index + 1) % items.length]?.classList.add("active");
    active?.classList.remove("active");
    items[(index + 1) % items.length]?.classList.add("active");
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    items[(index - 1 + items.length) % items.length]?.classList.add("active");
    active?.classList.remove("active");
    items[(index - 1 + items.length) % items.length]?.classList.add("active");
  } else if (event.key === "Enter") {
    const label = document.querySelector(".palette-item.active")?.dataset.palette;
    if (label) runPalette(label);
  }
});

document.addEventListener("keydown", (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (state.screen === "palette") closePalette();
    else openPalette();
    return;
  }
  if (mod && event.key.toLowerCase() === "b") {
    event.preventDefault();
    app.classList.toggle("sidebar-collapsed");
    return;
  }
  if (mod && event.key.toLowerCase() === "t") {
    event.preventDefault();
    setReasoning((Number(reasoningRange?.value ?? 2) + 1) % 3);
    return;
  }
  if (event.key === "Escape") {
    if (body.classList.contains("panel-picker-open")) {
      body.classList.remove("panel-picker-open");
      return;
    }
    if (body.classList.contains("terminal-open")) {
      body.classList.remove("terminal-open");
      return;
    }
    if (menuLayer?.classList.contains("open")) return closeMenu();
    if (dialogOverlay?.classList.contains("open")) return closeDialog();
    if (["approval", "plan", "question", "settings", "palette"].includes(state.screen)) {
      setScreen("conversation");
    }
    return;
  }
  if (event.key.toLowerCase() === "p" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
    setPresent(!state.present);
  }
  if (state.screen === "approval" && ["1", "2", "3", "4"].includes(event.key)) {
    const option = document.querySelector(`.approval-option[data-approval="${["once", "session", "always", "deny"][Number(event.key) - 1]}"]`);
    option?.click();
  }
  if (state.screen === "approval" && event.key === "Enter") {
    (document.querySelector(".approval-option.selected") ?? document.querySelector(".approval-option.primary"))?.click();
    setScreen("conversation");
  }
  if (state.screen === "question" && event.key === "Enter") {
    const selected = document.querySelector(".question-option.selected");
    if (selected) {
      showToast("已提交选择（原型）");
      setScreen("conversation");
    }
  }
});

/* ---------- initial state ---------- */
setTheme(state.theme);
setPresent(state.present);
body.dataset.screen = state.screen;
const initialTitle = document.getElementById("project-title");
if (initialTitle && state.screen === "empty") initialTitle.textContent = "新会话";
if (state.screen === "context") app.classList.add("context-open");
if (state.screen === "settings") openSettings("models");
if (state.screen === "palette") openPalette();
updateWorkspaceUI();
setBusy(false);
renderAttachments();
renderQueue();
syncProtoButtons();
syncPrimaryNav();
autoResize();

import { useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  Folder,
  Monitor,
  Moon,
  ShieldCheck,
  Sun,
  X,
  Sparkles,
} from "lucide-react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";
import { useTheme, type ThemeMode } from "../hooks/useTheme.js";

interface ProviderInfo {
  name: string;
  type: string;
  baseURL?: string;
  keyRef?: string;
}

interface ConfigInfo {
  defaultModel: string | null;
  providers: ProviderInfo[];
}

interface WorkspaceInfo {
  path: string;
  name: string;
  trusted: boolean;
}

type Tab = "models" | "appearance" | "permissions" | "about";
type ProbeState = "idle" | "testing" | "ok" | "error";

const TABS: Array<{ id: Tab; label: string; group: string; icon: typeof Sparkles }> = [
  { id: "models", label: "模型", group: "基础设置", icon: Sparkles },
  { id: "appearance", label: "外观", group: "基础设置", icon: Sun },
  { id: "permissions", label: "权限", group: "基础设置", icon: ShieldCheck },
  { id: "about", label: "关于", group: "其他", icon: Folder },
];

const TITLES: Record<Tab, { title: string; desc: string }> = {
  models: { title: "模型设置", desc: "查看默认模型与本地 provider 配置。" },
  appearance: { title: "外观", desc: "选择桌面端主题；当前 v2 侧栏保持纯白。" },
  permissions: { title: "权限", desc: "管理工作区信任；信任在下一个新会话生效。" },
  about: { title: "关于", desc: "本地运行信息与配置位置。" },
};

/** Slice 3：全页设置（原型布局，只接真实配置）。 */
export function SettingsPage(props: {
  conn: HostConnection;
  onClose(): void;
  appVersion: string;
  model: string | null;
  cwd: string;
}) {
  const [tab, setTab] = useState<Tab>("models");
  const [config, setConfig] = useState<ConfigInfo | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [selected, setSelected] = useState(0);
  const [probe, setProbe] = useState<ProbeState>("idle");
  const [error, setError] = useState("");
  const [workspaceNotice, setWorkspaceNotice] = useState("");
  const [currentTrusted, setCurrentTrusted] = useState(false);
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  useEffect(() => {
    if (props.conn.status !== "ready") return;
    let cancelled = false;
    void (async () => {
      try {
        const result = (await props.conn.send("config/get")) as ConfigInfo;
        if (cancelled) return;
        setConfig(result);
        setSelected(0);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
      try {
        const result = (await props.conn.send("workspace/list")) as { workspaces?: WorkspaceInfo[] };
        if (!cancelled) {
          const list = result.workspaces ?? [];
          setWorkspaces(list);
          setCurrentTrusted(
            list.some((workspace) => normalize(workspace.path) === normalize(props.cwd) && workspace.trusted),
          );
        }
      } catch {
        // 注册表不可用时只显示当前工作区。
      }
      try {
        const status = (await props.conn.send("workspace/status", { path: props.cwd })) as { trusted?: boolean };
        if (!cancelled) setCurrentTrusted(status.trusted === true);
      } catch {
        // 旧 host 不支持 status 时保留列表结果。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.conn.send, props.conn.status, props.cwd]);

  const provider = config?.providers[selected] ?? null;

  const testConnection = async (): Promise<void> => {
    setProbe("testing");
    try {
      const model = config?.defaultModel;
      await props.conn.send("provider/probe", model !== null && model !== undefined ? { model } : {});
      setProbe("ok");
    } catch {
      setProbe("error");
    }
  };

  const trust = async (path: string): Promise<void> => {
    try {
      await props.conn.send("workspace/trust", { path });
      setWorkspaces((prev) =>
        prev.map((workspace) => (normalize(workspace.path) === normalize(path) ? { ...workspace, trusted: true } : workspace)),
      );
      if (normalize(path) === normalize(props.cwd)) setCurrentTrusted(true);
      setWorkspaceNotice("已信任；下一个新会话生效");
    } catch (err) {
      setWorkspaceNotice(`信任失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="settings-v2" role="dialog" aria-modal="true" aria-label="设置">
      <aside className="sv-nav">
        <button type="button" className="sv-back" onClick={props.onClose}>
          <ChevronRight size={14} strokeWidth={1.8} className="sv-back-icon" />
          返回工作区
        </button>
        <div className="sv-brand">
          <span className="sv-logo">k</span>
          <span>设置</span>
        </div>
        <nav className="sv-nav-list">
          {(["基础设置", "其他"] as const).map((group) => (
            <div key={group}>
              <div className="sv-nav-group">{group}</div>
              {TABS.filter((item) => item.group === group).map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`sv-nav-item ${tab === item.id ? "active" : ""}`}
                    onClick={() => setTab(item.id)}
                  >
                    <Icon size={14} strokeWidth={1.7} />
                    {item.label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sv-nav-foot"><span className="sv-dot" />本地配置</div>
      </aside>

      <main className="sv-main">
        <header className="sv-head">
          <div>
            <h2>{TITLES[tab].title}</h2>
            <p>{TITLES[tab].desc}</p>
          </div>
          <button type="button" className="sv-close" onClick={props.onClose} title="关闭（Esc）">
            <X size={17} strokeWidth={1.7} />
          </button>
        </header>

        <div className="sv-body">
          {error !== "" ? <div className="sv-error">{error}</div> : null}

          {tab === "models" ? (
            <>
              <div className="sv-row">
                <div className="sv-row-copy">
                  <strong>默认模型</strong>
                  <span>每个新会话使用的模型</span>
                </div>
                <span className="sv-select-like"><span className="sv-dot" />{config?.defaultModel ?? props.model ?? "未配置"}</span>
              </div>
              <div className="sv-provider-layout">
                <div className="sv-provider-list">
                  <div className="sv-list-label">本地 Provider</div>
                  {config !== null && config.providers.length > 0 ? (
                    config.providers.map((item, index) => (
                      <button
                        key={item.name}
                        type="button"
                        className={`sv-provider-item ${index === selected ? "active" : ""}`}
                        onClick={() => { setSelected(index); setProbe("idle"); }}
                      >
                        <span className="sv-provider-avatar">{item.name.slice(0, 1).toUpperCase()}</span>
                        <span className="sv-provider-copy">
                          <strong>{item.name}</strong>
                          <span>{item.type}</span>
                        </span>
                        {index === selected ? <Check size={13} strokeWidth={2} /> : null}
                      </button>
                    ))
                  ) : (
                    <div className="sv-empty-small">尚未配置 Provider</div>
                  )}
                </div>
                <div className="sv-provider-detail">
                  {provider !== null ? (
                    <>
                      <div className="sv-provider-detail-head">
                        <span className="sv-provider-avatar">{provider.name.slice(0, 1).toUpperCase()}</span>
                        <div><strong>{provider.name}</strong><span>{provider.type}</span></div>
                      </div>
                      <label className="sv-field"><span>Base URL</span><input value={provider.baseURL ?? "（未配置）"} readOnly /></label>
                      <label className="sv-field"><span>Key 引用</span><input value={provider.keyRef ?? "（无）"} readOnly /></label>
                      <div className="sv-actions">
                        <span className={`sv-probe ${probe}`}>
                          {probe === "testing" ? "测试中…" : probe === "ok" ? "连接可用" : probe === "error" ? "连接失败" : ""}
                        </span>
                        <button type="button" className="sv-secondary" onClick={() => void testConnection()}>测试默认模型</button>
                      </div>
                    </>
                  ) : (
                    <div className="sv-empty">配置 Provider 后会显示连接信息。</div>
                  )}
                </div>
              </div>
            </>
          ) : null}

          {tab === "appearance" ? (
            <>
              <div className="sv-row">
                <div className="sv-row-copy">
                  <strong>主题</strong>
                  <span>设置页与主界面跟随这个选项；v2 侧栏保持纯白</span>
                </div>
                <div className="sv-theme">
                  {([["system", Monitor], ["light", Sun], ["dark", Moon]] as const).map(([value, Icon]) => (
                    <button
                      key={value}
                      type="button"
                      className={theme === value ? "active" : ""}
                      onClick={() => setTheme(value as ThemeMode)}
                    >
                      <Icon size={14} strokeWidth={1.7} />
                      {value === "system" ? "跟随系统" : value === "light" ? "亮色" : "暗色"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="sv-note">当前版本只开放主题切换；信息密度随主界面统一调整。</div>
            </>
          ) : null}

          {tab === "permissions" ? (
            <>
              <div className="sv-row">
                <div className="sv-row-copy">
                  <strong>当前工作区</strong>
                  <span>{props.cwd}</span>
                </div>
                {currentTrusted ? (
                  <span className="sv-trusted"><Check size={13} />已信任</span>
                ) : (
                  <button type="button" className="sv-primary" onClick={() => void trust(props.cwd)}>信任此工作区</button>
                )}
              </div>
              <div className="sv-list-label">已登记工作区</div>
              <div className="sv-trust-list">
                {workspaces.map((workspace) => (
                  <div className="sv-trust-row" key={workspace.path}>
                    <div><strong>{workspace.name}</strong><span>{workspace.path}</span></div>
                    {workspace.trusted ? (
                      <span className="sv-trusted"><Check size={13} />已信任</span>
                    ) : (
                      <button type="button" className="sv-secondary" onClick={() => void trust(workspace.path)}>信任</button>
                    )}
                  </div>
                ))}
                {workspaces.length === 0 ? <div className="sv-empty-small">还没有登记工作区</div> : null}
              </div>
              <div className="sv-note">信任只影响下一次新建会话；旧会话不会热更新规则。</div>
              {workspaceNotice !== "" ? <div className="sv-notice">{workspaceNotice}</div> : null}
            </>
          ) : null}

          {tab === "about" ? (
            <div className="sv-about">
              <div className="sv-row"><div className="sv-row-copy"><strong>版本</strong><span>kcode desktop</span></div><span>{props.appVersion}</span></div>
              <div className="sv-row"><div className="sv-row-copy"><strong>默认模型</strong><span>新会话默认值</span></div><span>{props.model ?? "未配置"}</span></div>
              <div className="sv-row"><div className="sv-row-copy"><strong>工作目录</strong><span>当前会话 cwd</span></div><span className="sv-mono">{props.cwd}</span></div>
              <div className="sv-row"><div className="sv-row-copy"><strong>配置</strong><span>本地 host 持有密钥与会话</span></div><span className="sv-mono">~/.kcode</span></div>
            </div>
          ) : null}
        </div>

        <footer className="sv-foot"><span>设置只保存在本机</span><span>Esc 关闭</span></footer>
      </main>
    </div>
  );
}

function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

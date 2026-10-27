import { useCallback, useEffect, useState } from "react";
import { Plug, Puzzle, TerminalSquare, Wrench } from "lucide-react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";

/**
 * S1-6（F14 第一批）：扩展子页——插件（启停/本地安装）/ 技能 / 命令 / MCP 一站式只读清单，
 * 数据来自 host `extensions/list`（项目级来源遵守 trust 边界）；动作走既有 extensions 实现。
 */
type Section = "plugins" | "skills" | "commands" | "mcp";

interface Overview {
  plugins: Array<{
    name: string;
    version: string;
    enabled: boolean;
    signed: boolean;
    signedBy?: string;
    skills: number;
    commands: number;
    hooks: number;
    mcp: number;
  }>;
  skills: Array<{ name: string; description: string; source: string; manualOnly: boolean }>;
  commands: Array<{ name: string; source: string; description?: string }>;
  mcp: { user: Array<{ name: string; transport: string }>; project: Array<{ name: string; transport: string }> };
}

const SECTIONS: Array<{ id: Section; label: string; icon: typeof Plug }> = [
  { id: "plugins", label: "插件", icon: Plug },
  { id: "skills", label: "技能", icon: Puzzle },
  { id: "commands", label: "命令", icon: TerminalSquare },
  { id: "mcp", label: "MCP", icon: Wrench },
];

export function SettingsExtensions({ conn }: { conn: HostConnection }) {
  const [section, setSection] = useState<Section>("plugins");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void conn
      .send("extensions/list")
      .then((r) => setData(r as Overview))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [conn]);

  useEffect(refresh, [refresh]);

  const toggle = (name: string, enabled: boolean): void => {
    setBusy(true);
    void conn
      .send("plugins/set_enabled", { name, enabled })
      .then(refresh)
      .catch((err) => window.alert(`操作失败：${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusy(false));
  };

  const install = (): void => {
    void window.kcodeHost?.pickDirectory().then((dir) => {
      if (dir === null || dir === undefined || dir === "") return;
      setBusy(true);
      void conn
        .send("plugins/install", { sourceDir: dir })
        .then((r) => {
          const info = r as { name: string; consentSummary: string };
          window.alert(`已安装 ${info.name}\n\n权限摘要：${info.consentSummary}`);
          refresh();
        })
        .catch((err) => window.alert(`安装失败：${err instanceof Error ? err.message : String(err)}`))
        .finally(() => setBusy(false));
    });
  };

  return (
    <div className="sv-ext">
      <div className="sv-ext-nav">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={section === id ? "active" : ""} onClick={() => setSection(id)}>
            <Icon size={13} strokeWidth={1.8} />
            {label}
          </button>
        ))}
      </div>
      {error !== "" ? <div className="sv-error">读取失败：{error}</div> : null}
      {data === null && error === "" ? <div className="sv-hint">读取中…</div> : null}
      {data !== null && section === "plugins" ? (
        <div className="sv-ext-list">
          <div className="sv-ext-toolbar">
            <span className="sv-hint">本地插件管理（与 CLI `kcode plugin` 同一存储）；市场功能建设中</span>
            <button type="button" className="sv-ext-install" disabled={busy} onClick={install}>
              安装本地插件…
            </button>
          </div>
          {data.plugins.length === 0 ? <div className="sv-hint">还没有安装插件</div> : null}
          {data.plugins.map((plugin) => (
            <div key={`${plugin.name}@${plugin.version}`} className="sv-ext-item" data-plugin={plugin.name}>
              <div className="sv-ext-item-main">
                <strong>{plugin.name}@{plugin.version}</strong>
                <span className={`sv-ext-badge ${plugin.signed ? "ok" : "warn"}`}>
                  {plugin.signed ? `已签名${plugin.signedBy !== undefined ? ` · ${plugin.signedBy}` : ""}` : "未签名"}
                </span>
                <span className="sv-hint">
                  技能×{plugin.skills} · 命令×{plugin.commands} · hooks×{plugin.hooks} · MCP×{plugin.mcp}
                </span>
              </div>
              <button type="button" disabled={busy} onClick={() => toggle(plugin.name, !plugin.enabled)}>
                {plugin.enabled ? "停用" : "启用"}
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {data !== null && section === "skills" ? (
        <div className="sv-ext-list">
          {data.skills.length === 0 ? <div className="sv-hint">暂无技能（.kcode/skills 或 ~/.kcode/skills）</div> : null}
          {data.skills.map((skill) => (
            <div key={skill.name} className="sv-ext-item" data-skill={skill.name}>
              <div className="sv-ext-item-main">
                <strong>{skill.name}</strong>
                <span className="sv-ext-badge">{skill.source}</span>
                {skill.manualOnly ? <span className="sv-ext-badge warn">手动</span> : null}
                <span className="sv-hint">{skill.description}</span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {data !== null && section === "commands" ? (
        <div className="sv-ext-list">
          {data.commands.length === 0 ? <div className="sv-hint">暂无自定义命令（.kcode/commands 或 ~/.kcode/commands）</div> : null}
          {data.commands.map((cmd) => (
            <div key={cmd.name} className="sv-ext-item" data-command={cmd.name}>
              <div className="sv-ext-item-main">
                <strong>/{cmd.name}</strong>
                <span className="sv-ext-badge">{cmd.source}</span>
                {cmd.description !== undefined ? <span className="sv-hint">{cmd.description}</span> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {data !== null && section === "mcp" ? (
        <div className="sv-ext-list">
          <div className="sv-ext-group-title">用户级（~/.kcode/mcp.json）</div>
          {data.mcp.user.length === 0 ? <div className="sv-hint">未配置（CLI `kcode mcp add` 可添加）</div> : null}
          {data.mcp.user.map((server) => (
            <div key={server.name} className="sv-ext-item" data-mcp={server.name}>
              <div className="sv-ext-item-main">
                <strong>{server.name}</strong>
                <span className="sv-ext-badge">{server.transport}</span>
              </div>
            </div>
          ))}
          {data.mcp.project.length > 0 ? (
            <>
              <div className="sv-ext-group-title">项目级（.kcode/mcp.json，需信任）</div>
              {data.mcp.project.map((server) => (
                <div key={server.name} className="sv-ext-item">
                  <div className="sv-ext-item-main">
                    <strong>{server.name}</strong>
                    <span className="sv-ext-badge">{server.transport}</span>
                  </div>
                </div>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

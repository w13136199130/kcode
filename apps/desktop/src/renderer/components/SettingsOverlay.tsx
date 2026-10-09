import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

/**
 * 设置覆盖层（M3b 最小版，zcode 覆盖层模式——主界面保留不卸载）：
 * 外观（亮/暗/跟随系统——覆盖 media query）+ 应用信息（版本/默认模型/工作目录）。
 * 完整设置（provider/MCP/skills）随 N4 与 provider 管理一起。
 */
export function SettingsOverlay(props: { onClose(): void; appVersion: string; model: string | null; cwd: string }) {
  const [theme, setTheme] = useState<"system" | "light" | "dark">(
    () => (localStorage.getItem("kcode-theme") as "system" | "light" | "dark" | null) ?? "system",
  );

  useEffect(() => {
    // 覆盖媒体查询：显式主题时注入固定变量表（webCssTheme 的 dark 块被 :root 内联覆盖）
    const styleId = "kcode-theme-override";
    document.getElementById(styleId)?.remove();
    if (theme !== "system") {
      const dark = theme === "dark";
      const vars = [
        "--kcode-bg",
        "--kcode-bg-panel",
        "--kcode-bg-subtle",
        "--kcode-border",
        "--kcode-foreground",
        "--kcode-foreground-subtle",
      ];
      // 亮暗基础面（语义色 brand 等保持设计默认）
      const light: Record<string, string> = {
        "--kcode-bg": "#fafafa",
        "--kcode-bg-panel": "#ffffff",
        "--kcode-bg-subtle": "#f3f4f6",
        "--kcode-border": "#e5e7eb",
        "--kcode-foreground": "#1a1a2e",
        "--kcode-foreground-subtle": "#6b7280",
      };
      const darkMap: Record<string, string> = {
        "--kcode-bg": "#161616",
        "--kcode-bg-panel": "#202020",
        "--kcode-bg-subtle": "rgba(255,255,255,0.05)",
        "--kcode-border": "rgba(255,255,255,0.1)",
        "--kcode-foreground": "#d4d4d4",
        "--kcode-foreground-subtle": "rgba(212,212,212,0.6)",
      };
      const map = dark ? darkMap : light;
      const el = document.createElement("style");
      el.id = styleId;
      el.textContent = `:root { ${vars.map((v) => `${v}: ${map[v]!};`).join(" ")} }`;
      document.head.appendChild(el);
    }
    localStorage.setItem("kcode-theme", theme);
  }, [theme]);

  return (
    <div className="palette-backdrop" onClick={props.onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">设置</div>
        <div className="settings-section">
          <div className="settings-label">外观</div>
          <div className="settings-row">
            {(["system", "light", "dark"] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={`ask-btn theme-btn ${theme === t ? "allow" : ""}`}
                onClick={() => setTheme(t)}
              >
                {t === "system" ? <Monitor size={14} strokeWidth={1.75} /> : t === "light" ? <Sun size={14} strokeWidth={1.75} /> : <Moon size={14} strokeWidth={1.75} />}
                {t === "system" ? "跟随系统" : t === "light" ? "亮色" : "暗色"}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-section">
          <div className="settings-label">应用</div>
          <div className="settings-info">
            <div>版本 kcode {props.appVersion}</div>
            <div>默认模型 {props.model ?? "（未配置）"}</div>
            <div className="dim">工作目录 {props.cwd}</div>
            <div className="dim">宿主进程持有会话与 key；渲染层 sandbox 无文件访问</div>
          </div>
        </div>
        <div className="settings-foot">
          <button type="button" className="ask-btn" onClick={props.onClose}>
            关闭（Esc）
          </button>
        </div>
      </div>
    </div>
  );
}

import { useState } from "react";
import { LOGIN_PRESETS } from "@kcode/contracts";
import type { HostConnection } from "@web/hooks/useHostConnection.js";

/**
 * D1-01：首次运行引导。无 config / 无 default 时不再卡在空白窗口；
 * key 只经 host 的 config/save 进 keychain（renderer 从不直接写文件/钥匙串）。
 */
export function Onboarding(props: {
  conn: HostConnection;
  initialCwd: string;
  onComplete(modelRef: string, cwd: string): void;
}) {
  const [cwd, setCwd] = useState(props.initialCwd);
  const [presetIdx, setPresetIdx] = useState(0);
  const [providerName, setProviderName] = useState(LOGIN_PRESETS[0]!.name);
  const [baseURL, setBaseURL] = useState(LOGIN_PRESETS[0]!.baseURL);
  const [model, setModel] = useState(LOGIN_PRESETS[0]!.model);
  const [apiKey, setApiKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickPreset = (idx: number): void => {
    const preset = LOGIN_PRESETS[idx]!;
    setPresetIdx(idx);
    setProviderName(preset.name);
    setBaseURL(preset.baseURL);
    setModel(preset.model);
    setError(null);
  };

  const browse = async (): Promise<void> => {
    const dir = await window.kcodeHost?.pickDirectory();
    if (dir !== null && dir !== undefined && dir !== "") setCwd(dir);
  };

  const submit = async (): Promise<void> => {
    if (!/^https?:\/\//i.test(baseURL)) {
      setError("Base URL 必须是 http(s) 地址");
      return;
    }
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(providerName)) {
      setError("provider 名只能是小写字母/数字/短横线（a-z0-9-）");
      return;
    }
    if (model.trim() === "" || apiKey.trim() === "" || cwd.trim() === "") {
      setError("工作区、模型与 API key 均不能为空");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const keyRef = `keychain://${providerName}`;
      const modelRef = `${providerName}/${model.trim()}`;
      await props.conn.send("config/save", {
        providerName,
        provider: { type: "openai-compatible", baseURL, keyRef },
        model: modelRef,
        key: {
          ref: keyRef,
          key: apiKey.trim(),
          audiences: [baseURL],
          ...(passphrase !== "" ? { passphrase } : {}),
        },
      });
      props.onComplete(modelRef, cwd);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboarding-root">
      <form
        className="onboarding-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1>欢迎使用 kcode</h1>
        <p className="onboarding-lead">选择项目目录并配置一个模型供应商，完成后即可开始对话。</p>

        <label className="onboarding-label">项目目录</label>
        <div className="onboarding-row">
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="项目文件夹路径" />
          <button type="button" className="onboarding-secondary" onClick={() => void browse()}>
            选择…
          </button>
        </div>

        <label className="onboarding-label">厂商预设</label>
        <div className="onboarding-presets">
          {LOGIN_PRESETS.map((preset, idx) => (
            <button
              key={preset.key}
              type="button"
              className={`onboarding-preset ${idx === presetIdx ? "active" : ""}`}
              onClick={() => pickPreset(idx)}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <label className="onboarding-label">Provider 名</label>
        <input value={providerName} onChange={(e) => setProviderName(e.target.value)} />

        <label className="onboarding-label">Base URL</label>
        <input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://…/v1" />

        <label className="onboarding-label">模型</label>
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" />

        <label className="onboarding-label">API key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="只发送给宿主进程，写入系统钥匙串"
          autoComplete="off"
        />

        <label className="onboarding-label">Keychain 口令（非 Windows；Windows 可留空）</label>
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="留空 = 使用系统安全存储"
          autoComplete="off"
        />

        {error !== null ? <div className="onboarding-error">{error}</div> : null}
        <button type="submit" className="onboarding-primary" disabled={busy}>
          {busy ? "保存中…" : "保存并开始"}
        </button>
        <p className="onboarding-hint">key 会写入本机钥匙串；配置文件只保存 provider 与模型引用。</p>
      </form>
    </div>
  );
}

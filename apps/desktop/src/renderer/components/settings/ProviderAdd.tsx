import { useState } from "react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";

/**
 * S1-6（F14）：provider 预设网格 + 添加供应商流程。
 * 保存复用 onboarding 同一链路：config/save（key 只进 keychain，renderer 不落盘）。
 */
const PRESETS: Array<{ name: string; baseURL: string; modelHint: string }> = [
  { name: "bigmodel", baseURL: "https://open.bigmodel.cn/api/paas/v4", modelHint: "glm-4.6" },
  { name: "deepseek", baseURL: "https://api.deepseek.com/v1", modelHint: "deepseek-chat" },
  { name: "moonshot", baseURL: "https://api.moonshot.cn/v1", modelHint: "kimi-k2" },
  { name: "openai", baseURL: "https://api.openai.com/v1", modelHint: "gpt-4o" },
  { name: "custom", baseURL: "", modelHint: "your-model" },
];

export function ProviderAdd({ conn, onSaved }: { conn: HostConnection; onSaved(): void }) {
  const [preset, setPreset] = useState(PRESETS[0]!);
  const [providerName, setProviderName] = useState(PRESETS[0]!.name);
  const [baseURL, setBaseURL] = useState(PRESETS[0]!.baseURL);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const pick = (index: number): void => {
    const next = PRESETS[index]!;
    setPreset(next);
    setProviderName(next.name);
    setBaseURL(next.baseURL);
  };

  const save = (): void => {
    if (!/^https?:\/\//.test(baseURL.trim())) {
      setError("Base URL 必须是 http(s) 地址");
      return;
    }
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(providerName.trim())) {
      setError("provider 名只能是小写字母/数字/短横线");
      return;
    }
    if (apiKey.trim() === "") {
      setError("API key 不能为空");
      return;
    }
    setBusy(true);
    setError("");
    const keyRef = `keychain://${providerName.trim()}`;
    void conn
      .send("config/save", {
        providerName: providerName.trim(),
        provider: { type: "openai-compatible", baseURL: baseURL.trim(), keyRef },
        ...(model.trim() !== "" ? { model: `${providerName.trim()}/${model.trim()}` } : {}),
        key: { ref: keyRef, key: apiKey.trim(), audiences: [baseURL.trim()] },
      })
      .then(() => {
        onSaved();
        setApiKey("");
        setModel("");
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="sv-provider-add">
      <div className="sv-preset-grid">
        {PRESETS.map((item, index) => (
          <button
            key={item.name}
            type="button"
            className={preset.name === item.name ? "active" : ""}
            onClick={() => pick(index)}
          >
            <strong>{item.name === "custom" ? "自定义" : item.name}</strong>
            <span>{item.name === "custom" ? "任意 OpenAI 兼容端点" : item.modelHint}</span>
          </button>
        ))}
      </div>
      <div className="sv-form">
        <label>
          provider 名
          <input value={providerName} onChange={(e) => setProviderName(e.target.value)} />
        </label>
        <label>
          Base URL
          <input value={baseURL} placeholder="https://…" onChange={(e) => setBaseURL(e.target.value)} />
        </label>
        <label>
          API key
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </label>
        <label>
          默认模型（可选）
          <input value={model} placeholder={preset.modelHint} onChange={(e) => setModel(e.target.value)} />
        </label>
      </div>
      {error !== "" ? <div className="sv-error">{error}</div> : null}
      <button type="button" className="sv-provider-save" disabled={busy} onClick={save}>
        {busy ? "保存中…" : "保存供应商"}
      </button>
    </div>
  );
}

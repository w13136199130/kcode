import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Paperclip, Square, X } from "lucide-react";
import type { CommandInfo, PermissionMode } from "@kcode/contracts";

/** 模式四档的 composer 选择器元数据（与 CLI MODE_META 同语义） */
const MODES: Array<{ value: PermissionMode; label: string }> = [
  { value: "plan", label: "⏸ 只读" },
  { value: "default", label: "⏵ 变更确认" },
  { value: "acceptEdits", label: "⏵⏵ 自动编辑" },
  { value: "fullAccess", label: "⏵⏵⏵ 完全访问" },
];

type MenuKind = "slash" | "file";

/**
 * Composer（M2a）：多行输入 + 底部工具条 + D1-05 的 `/` 命令菜单与 `@` 文件补全。
 * Enter 发送 / Shift+Enter 换行（IME 组词保护）；菜单打开时 Enter 选中、Esc 关闭。
 */
export function Composer(props: {
  /** 仅门控发送等动作；输入框任何时候都可编辑（ZCode 式：连接/会话准备中先写草稿）。 */
  busy: boolean;
  disabled: boolean;
  queuedCount: number;
  mode: PermissionMode;
  model: string | null;
  context?: { historyTokens: number; contextWindow: number; windowKnown: boolean } | null;
  /** 空态快捷入口：由外层填入一段可编辑草稿。 */
  prefill?: { text: string; nonce: number } | null;
  commands: readonly CommandInfo[];
  onListFiles(query: string): Promise<string[]>;
  onListModels?(): Promise<string[]>;
  onModelChange?(model: string): Promise<boolean> | void;
  onModeChange(mode: PermissionMode): void;
  onSend(text: string, images?: readonly string[]): void;
  onStop(): void;
  onPickImages?(): Promise<string[]>;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [menu, setMenu] = useState<MenuKind | null>(null);
  const [active, setActive] = useState(0);
  const [fileMatches, setFileMatches] = useState<string[]>([]);
  const [modelMenu, setModelMenu] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const slashQuery = /^\/([a-z0-9-]*)$/.exec(text.slice(0, ref.current?.selectionStart ?? text.length));
  const slashItems =
    slashQuery !== null
      ? props.commands.filter((c) => c.hidden !== true && c.name.includes(slashQuery[1] ?? ""))
      : [];
  const items = menu === "slash" ? slashItems : fileMatches;

  const autoSize = (): void => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  useEffect(() => {
    if (props.prefill === null || props.prefill === undefined) return;
    setText(props.prefill.text);
    setMenu(null);
    requestAnimationFrame(() => {
      ref.current?.focus();
      autoSize();
    });
  }, [props.prefill]);

  const refreshMenu = (value: string, caret: number): void => {
    const before = value.slice(0, caret);
    if (/^\/([a-z0-9-]*)$/.test(before)) {
      setMenu("slash");
      setActive(0);
      return;
    }
    const file = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (file !== null) {
      setMenu("file");
      setActive(0);
      void props.onListFiles(file[1] ?? "").then((files) => setFileMatches(files));
      return;
    }
    setMenu(null);
  };

  const applyMenu = (index: number): void => {
    const caret = ref.current?.selectionStart ?? text.length;
    if (menu === "slash") {
      const cmd = slashItems[index];
      if (cmd === undefined) return;
      const next = `/${cmd.name} `;
      setText(next);
      setMenu(null);
      requestAnimationFrame(() => {
        ref.current?.focus();
        ref.current?.setSelectionRange(next.length, next.length);
      });
      return;
    }
    if (menu === "file") {
      const file = fileMatches[index];
      if (file === undefined) return;
      const before = text.slice(0, caret);
      const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
      if (match === null) return;
      const start = before.length - match[0].length + (match[0].startsWith("@") ? 0 : 1);
      const next = `${text.slice(0, start)}@${file} ${text.slice(caret)}`;
      setText(next);
      setMenu(null);
      requestAnimationFrame(() => {
        ref.current?.focus();
        ref.current?.setSelectionRange(start + file.length + 2, start + file.length + 2);
      });
    }
  };

  const send = (): void => {
    const t = text.trim();
    // D1-05：运行中也可提交——host 侧 RuntimeCommandQueue 排队，本轮结束后按序执行
    if (t === "" || props.disabled) return;
    props.onSend(t, images);
    setText("");
    setImages([]);
    setMenu(null);
    requestAnimationFrame(autoSize);
  };

  const addImages = (): void => {
    if (props.onPickImages === undefined || props.disabled) return;
    void props
      .onPickImages()
      .then((paths) => {
        if (paths.length === 0) return;
        setImages((prev) => [...new Set([...prev, ...paths])].slice(0, 8));
      })
      .catch(() => undefined);
  };

  const removeImage = (path: string): void => {
    setImages((prev) => prev.filter((item) => item !== path));
  };

  const toggleModelMenu = (): void => {
    if (props.onListModels === undefined || props.onModelChange === undefined) return;
    if (modelMenu) {
      setModelMenu(false);
      return;
    }
    setModelMenu(true);
    setModelLoading(true);
    setModelError("");
    void props
      .onListModels()
      .then((models) => setModelOptions(models))
      .catch((err) => setModelError(err instanceof Error ? err.message : String(err)))
      .finally(() => setModelLoading(false));
  };

  const chooseModel = (model: string): void => {
    if (props.onModelChange === undefined) return;
    void Promise.resolve(props.onModelChange(model)).then((ok) => {
      if (ok !== false) {
        setModelMenu(false);
        setModelOptions([model]);
      }
    });
  };

  const shortModel = props.model !== null && props.model.includes("/")
    ? props.model.split("/").slice(1).join("/")
    : props.model;
  const contextPct =
    props.context !== undefined && props.context !== null && props.context.contextWindow > 0
      ? Math.min(100, Math.max(0, Math.round((props.context.historyTokens / props.context.contextWindow) * 100)))
      : null;

  return (
    <div className="composer composer-v2">
      {props.queuedCount > 0 ? <div className="composer-queued">已排队 {props.queuedCount} 条（Esc 可中断清空）</div> : null}
      {menu !== null && items.length > 0 ? (
        <div className="composer-menu" role="listbox">
          {items.slice(0, 8).map((item, i) => {
            const label = typeof item === "string" ? item : `/${item.name} ${item.argsHint ?? ""}`;
            const desc = typeof item === "string" ? "" : item.desc;
            return (
              <div
                key={typeof item === "string" ? item : item.name}
                className={`composer-menu-item ${i === active ? "active" : ""}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyMenu(i);
                }}
              >
                <span className="composer-menu-label">{label}</span>
                {desc !== "" ? <span className="composer-menu-desc">{desc}</span> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="composer-box">
        <textarea
          ref={ref}
          className="composer-input"
          value={text}
          placeholder={
            props.disabled
              ? "会话准备中…可先输入草稿"
              : "描述任务，Enter 发送 · / 命令 · @ 文件 · Shift+Enter 换行"
          }
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            refreshMenu(e.target.value, e.target.selectionStart ?? e.target.value.length);
            autoSize();
          }}
          onKeyDown={(e) => {
            if (menu !== null && items.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((v) => (v + 1) % items.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((v) => (v - 1 + items.length) % items.length);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                applyMenu(active);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMenu(null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        {images.length > 0 ? (
          <div className="composer-attachments">
            {images.map((path) => (
              <span key={path} className="ca-chip" title={path}>
                <Paperclip size={10} strokeWidth={1.8} />
                {path.split(/[\\/]/).at(-1) ?? path}
                <button type="button" onClick={() => removeImage(path)} title="移除">
                  <X size={10} strokeWidth={2} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="composer-toolbar">
          <button
            type="button"
            className="composer-attach"
            onClick={addImages}
            disabled={props.disabled}
            title="添加图片（最多 8 张）"
          >
            <Paperclip size={14} strokeWidth={1.8} />
          </button>
          <select
            className="composer-mode"
            value={props.mode}
            disabled={props.disabled}
            onChange={(e) => props.onModeChange(e.target.value as PermissionMode)}
            title="权限模式"
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <div className="composer-toolbar-right">
            {contextPct !== null ? (
              <span
                className="composer-context"
                role="img"
                aria-label={`上下文 ${contextPct}%`}
                title={contextTooltip(props.context)}
                style={{
                  background: `conic-gradient(#b9b9b9 ${contextPct * 3.6}deg, #eeeeee 0deg)`,
                }}
              >
                <span />
              </span>
            ) : null}
            {shortModel !== null && shortModel !== "" ? (
              <div className="composer-model-wrap">
                {props.onListModels !== undefined && props.onModelChange !== undefined ? (
                  <button
                    type="button"
                    className="composer-model composer-model-button"
                    title={props.model ?? ""}
                    onClick={toggleModelMenu}
                  >
                    {shortModel}
                    <ChevronDown size={10} strokeWidth={2} />
                  </button>
                ) : (
                  <span className="composer-model" title={props.model ?? ""}>
                    {shortModel}
                  </span>
                )}
                {modelMenu ? (
                  <div className="composer-model-menu" role="listbox">
                    {modelLoading ? <div className="cmm-note">读取模型列表…</div> : null}
                    {modelError !== "" ? <div className="cmm-note error">{modelError}</div> : null}
                    {!modelLoading && modelError === ""
                      ? modelOptions.map((model) => (
                          <button
                            key={model}
                            type="button"
                            role="option"
                            aria-selected={model === props.model}
                            className={model === props.model ? "active" : ""}
                            onClick={() => chooseModel(model)}
                          >
                            {model}
                          </button>
                        ))
                      : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            {props.busy ? (
              <button type="button" className="composer-stop" onClick={props.onStop} title="中断当前运行（Esc）">
                <Square size={13} strokeWidth={2} />
              </button>
            ) : null}
            <button
              type="button"
              className="composer-send"
              disabled={text.trim() === "" || props.disabled}
              onClick={send}
              title={props.busy ? "排队（Enter）" : "发送（Enter）"}
            >
              <ArrowUp size={16} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** S3-2：上下文环 tooltip——注入项逐条（含 MCP 单服务器成本）+ 窗口占比 */
function contextTooltip(context?: { historyTokens: number; contextWindow: number; windowKnown: boolean; items?: Array<{ label: string; tokens: number; detail?: string }> } | null): string {
  if (context === undefined || context === null) return "上下文占用（暂无数据）";
  const pct =
    context.contextWindow > 0 ? `${((context.historyTokens / context.contextWindow) * 100).toFixed(1)}%` : "—";
  const lines = [
    `上下文 ${context.historyTokens.toLocaleString()} / ${context.contextWindow.toLocaleString()} tokens（${pct}）${context.windowKnown === false ? "（窗口为估算）" : ""}`,
  ];
  for (const item of context.items ?? []) {
    const detail = item.detail !== undefined ? `（${item.detail}）` : "";
    lines.push(`${item.label}${detail}：${item.tokens.toLocaleString()} tokens`);
  }
  return lines.join("\n");
}

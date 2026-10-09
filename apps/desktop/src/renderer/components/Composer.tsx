import { useRef, useState } from "react";
import type { PermissionMode } from "@kcode/contracts";

/** 模式四档的 composer 选择器元数据（与 CLI MODE_META 同语义） */
const MODES: Array<{ value: PermissionMode; label: string }> = [
  { value: "plan", label: "⏸ 只读" },
  { value: "default", label: "⏵ 变更确认" },
  { value: "acceptEdits", label: "⏵⏵ 自动编辑" },
  { value: "fullAccess", label: "⏵⏵⏵ 完全访问" },
];

/**
 * Composer（M2a，zcode 布局对标）：多行输入 + 底部工具条
 * （左：模式选择器——接 session/set_mode；右：模型名 + 发送/停止）。
 * Enter 发送 / Shift+Enter 换行（IME 组词保护）。
 */
export function Composer(props: {
  busy: boolean;
  disabled: boolean;
  queuedCount: number;
  mode: PermissionMode;
  model: string | null;
  onModeChange(mode: PermissionMode): void;
  onSend(text: string): void;
  onStop(): void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const autoSize = (): void => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const send = (): void => {
    const t = text.trim();
    if (t === "" || props.busy || props.disabled) return;
    props.onSend(t);
    setText("");
    requestAnimationFrame(autoSize);
  };

  const shortModel = props.model !== null && props.model.includes("/")
    ? props.model.split("/").slice(1).join("/")
    : props.model;

  return (
    <div className="composer">
      {props.queuedCount > 0 ? <div className="composer-queued">已排队 {props.queuedCount} 条（Esc 可中断清空）</div> : null}
      <div className="composer-box">
        <textarea
          ref={ref}
          className="composer-input"
          value={text}
          placeholder={props.disabled ? "连接宿主中…" : "描述任务，Enter 发送 · Shift+Enter 换行"}
          disabled={props.disabled}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            autoSize();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-toolbar">
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
            {shortModel !== null && shortModel !== "" ? (
              <span className="composer-model" title={props.model ?? ""}>
                {shortModel}
              </span>
            ) : null}
            {props.busy ? (
              <button type="button" className="composer-stop" onClick={props.onStop} title="中断当前运行">
                ■ 停止
              </button>
            ) : (
              <button
                type="button"
                className="composer-send"
                disabled={text.trim() === "" || props.disabled}
                onClick={send}
              >
                发送
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

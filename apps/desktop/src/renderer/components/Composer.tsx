import { useRef, useState } from "react";

/**
 * Composer（M2a 基础版，§8.4h）：多行自适应输入 + 发送状态机
 * （canSend → 运行中变 Stop（中断））。Enter 发送 / Shift+Enter 换行；
 * 斜杠命令菜单与 @ 补全随 M2b 模式/模型选择器一批落地。
 */
export function Composer(props: {
  busy: boolean;
  disabled: boolean;
  queuedCount: number;
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
  );
}

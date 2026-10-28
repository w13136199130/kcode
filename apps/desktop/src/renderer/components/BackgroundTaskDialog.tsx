import { useState } from "react";
import { Bot } from "lucide-react";

/**
 * S3-3：新建后台任务对话框——给后台会话一个首指令，任务在独立无头 host 里跑，
 * 不占当前窗口（侧栏出现运行中状态点，完成后可打开）。
 */
export function BackgroundTaskDialog(props: {
  workspacePath: string;
  busy: boolean;
  error: string;
  onStart(prompt: string): void;
  onCancel(): void;
}) {
  const [prompt, setPrompt] = useState("");
  const canStart = prompt.trim() !== "" && !props.busy;
  return (
    <div className="bg-dialog-backdrop" role="dialog" aria-label="新建后台任务">
      <div className="bg-dialog">
        <div className="bg-dialog-title">
          <Bot size={16} strokeWidth={1.8} />
          新建后台任务
          <span className="bg-dialog-ws">{props.workspacePath}</span>
        </div>
        <textarea
          className="bg-dialog-input"
          autoFocus
          rows={4}
          placeholder="要做什么？（任务会在独立后台进程运行，不占用当前窗口）"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canStart) props.onStart(prompt.trim());
            if (e.key === "Escape") props.onCancel();
          }}
        />
        {props.error !== "" ? <div className="bg-dialog-error">{props.error}</div> : null}
        <div className="bg-dialog-actions">
          <button type="button" className="ghost" onClick={props.onCancel}>
            取消
          </button>
          <button type="button" className="primary" disabled={!canStart} onClick={() => props.onStart(prompt.trim())}>
            {props.busy ? "启动中…" : "开始（Ctrl+Enter）"}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { formatGrantPattern, suggestGrant } from "../lib/grant-patterns.js";

/**
 * 审批四档面板（M2b，§8.4h）：允许 / 本会话 / 本项目（参数级规则内联展示——N3I-5
 * 桌面呈现）/ 拒绝。zcode 单键体验：bash/edit/write 的「本项目」档自动升级为
 * 参数级并在按钮文案里展示将保存的规则范围。
 */
export function AskPanel(props: {
  tool: string;
  args: unknown;
  /** 宿主侧生成的变更预览（write/edit）：完整 diff，renderer 无文件访问 */
  preview?: { path?: string; diff: string };
  onRespond(allowed: boolean, scope?: "once" | "session" | "project"): void;
}) {
  const [picked, setPicked] = useState(false);
  // D2-01：键盘可完成审批；默认焦点已在拒绝，所以 Enter 不会误放行
  useEffect(() => {
    if (picked) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const key = e.key.toLowerCase();
      const decide = (allowed: boolean, scope?: "once" | "session" | "project"): void => {
        e.preventDefault();
        setPicked(true);
        props.onRespond(allowed, scope);
      };
      if (key === "y") decide(true);
      else if (key === "s") decide(true, "session");
      else if (key === "p") decide(true, "project");
      else if (key === "n" || e.key === "Escape") decide(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [picked, props]);
  if (picked) return null;
  const suggestion = suggestGrant({ tool: props.tool, args: props.args });
  const projectLabel =
    suggestion !== null
      ? `本项目不再询问 · ${formatGrantPattern(suggestion)}`
      : "本项目不再询问";
  const sessionLabel =
    suggestion !== null
      ? `本会话不再询问 · ${formatGrantPattern(suggestion)}`
      : "本会话不再询问";
  const command =
    typeof (props.args as { command?: unknown } | null)?.command === "string"
      ? (props.args as { command: string }).command
      : null;
  const argsText = JSON.stringify(props.args, null, 2) ?? "";
  // D2-01：完整参数（容器可滚动），不再静默截断
  const argsPreview = command !== null ? command : argsText;

  const respond = (allowed: boolean, scope?: "once" | "session" | "project"): void => {
    setPicked(true);
    props.onRespond(allowed, scope);
  };

  return (
    <div className="ask-panel">
      <div className="ask-title">
        ⚠ 允许 <code>{props.tool}</code> ？
      </div>
      {command !== null ? (
        <pre className="ask-command">{command}</pre>
      ) : (
        <pre className="ask-args">{argsPreview}</pre>
      )}
      {props.preview !== undefined ? (
        <div className="ask-diff" aria-label="变更预览">
          {props.preview.path !== undefined ? <div className="ask-diff-path">{props.preview.path}</div> : null}
          {props.preview.diff.split("\n").map((line, i) => (
            <div
              key={i}
              className={
                line.startsWith("+") ? "diff-line diff-added" : line.startsWith("-") ? "diff-line diff-removed" : "diff-line"
              }
            >
              {line}
            </div>
          ))}
        </div>
      ) : null}
      <div className="ask-actions">
        <button type="button" className="ask-btn allow" onClick={() => respond(true)}>
          允许
        </button>
        <button type="button" className="ask-btn" onClick={() => respond(true, "session")}>
          {sessionLabel}
        </button>
        <button type="button" className="ask-btn" onClick={() => respond(true, "project")} title={suggestion !== null ? "保存参数级放行规则" : "保存工具级放行"}>
          {projectLabel}
        </button>
        <button type="button" className="ask-btn deny" onClick={() => respond(false)} autoFocus>
          拒绝
        </button>
      </div>
    </div>
  );
}

/** 结构化提问弹层（ask_user）：单选提交 labels */
export function QuestionPanel(props: {
  question: { question: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean };
  onRespond(labels: string[]): void;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const toggle = (i: number): void => {
    setSelected((prev) =>
      props.question.multiSelect === true
        ? prev.includes(i)
          ? prev.filter((x) => x !== i)
          : [...prev, i]
        : [i],
    );
  };
  return (
    <div className="ask-panel">
      <div className="ask-title">{props.question.question}</div>
      <div className="ask-options">
        {props.question.options.map((o, i) => (
          <button
            key={o.label}
            type="button"
            className={`ask-option ${selected.includes(i) ? "selected" : ""}`}
            onClick={() => toggle(i)}
          >
            <span className="ask-option-mark">{selected.includes(i) ? "☑" : "☐"}</span>
            <span>
              {o.label}
              {o.description !== undefined ? <span className="ask-option-desc"> — {o.description}</span> : null}
            </span>
          </button>
        ))}
      </div>
      <div className="ask-actions">
        <button
          type="button"
          className="ask-btn allow"
          disabled={selected.length === 0}
          onClick={() => props.onRespond(selected.map((i) => props.question.options[i]!.label))}
        >
          确认
        </button>
      </div>
    </div>
  );
}

import { Text } from "ink";
import { useInput, useStdin } from "ink";
import { useStore } from "zustand";
import type { UiStore } from "@kcode/ui";
import { InputBox } from "./InputBox.js";
import type { CommandInfo } from "./builtin-commands.js";
import { ToolBrowser } from "../transcript/ToolBrowser.js";
import { TaskBrowser } from "../tasks/TaskBrowser.js";
import { openInExternalEditor } from "./external-editor.js";

/**
 * 输入区装配（N3C-4②③④）：覆盖层面板打开时顶替输入框——方向键/回车归面板独占，
 * 不与输入光标/历史双响应；这与 DialogLayer"面板顶替 children"的既有模式一致。
 * 其余状态回落：未就绪 → 初始化提示；非交互 → 一次性提问提示。
 * Ctrl+E（外部编辑器）在这里处理而非 keybinds：它需要输入框的值与回填通道。
 */
export function InputArea(props: {
  ui: UiStore;
  ready: boolean;
  interactive: boolean;
  value: string;
  onChange(value: string): void;
  onSubmit(value: string): void;
  history: string[];
  commands: CommandInfo[];
  cwd: string;
  onCjkCommit(): void;
}) {
  const browserOpen = useStore(props.ui, (s) => s.toolBrowser.open);
  const taskBrowserOpen = useStore(props.ui, (s) => s.taskBrowser.open);
  const busy = useStore(props.ui, (s) => s.busy);
  const { setRawMode } = useStdin();
  const canEditExternally = props.interactive && props.ready && !busy && !browserOpen && !taskBrowserOpen;

  // Ctrl+E 外部编辑长输入：仅空闲可用（spawnSync 阻塞事件循环，运行中会冻结流式渲染）
  useInput(
    (ch, key) => {
      if (key.ctrl && ch === "e") {
        void openInExternalEditor(props.value, {
          suspend: () => setRawMode(false),
          resume: () => setRawMode(true),
        }).then((result) => {
          if (result.ok) {
            if (result.text !== props.value) {
              props.onChange(result.text);
            }
          } else {
            props.ui.getState().pushBlock({ kind: "info", tone: "warn", text: result.error });
          }
        });
      }
    },
    { isActive: canEditExternally },
  );

  if (taskBrowserOpen) {
    return <TaskBrowser ui={props.ui} />;
  }
  if (browserOpen) {
    return <ToolBrowser ui={props.ui} />;
  }
  if (!props.ready) {
    return <Text dimColor>初始化会话…</Text>;
  }
  if (!props.interactive) {
    return <Text dimColor>（非交互模式：仅执行一次性提问后退出）</Text>;
  }
  return (
    <InputBox
      value={props.value}
      onChange={props.onChange}
      onSubmit={props.onSubmit}
      history={props.history}
      commands={props.commands}
      cwd={props.cwd}
      onCjkCommit={props.onCjkCommit}
    />
  );
}

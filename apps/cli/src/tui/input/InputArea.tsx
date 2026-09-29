import { Text } from "ink";
import { useStore } from "zustand";
import type { UiStore } from "@kcode/ui";
import { InputBox } from "./InputBox.js";
import type { CommandInfo } from "./builtin-commands.js";
import { ToolBrowser } from "../transcript/ToolBrowser.js";

/**
 * 输入区装配（N3C-4②）：工具浏览器打开时顶替输入框——方向键/回车归浏览器独占，
 * 不与输入光标/历史双响应；这与 DialogLayer"面板顶替 children"的既有模式一致。
 * 其余状态回落：未就绪 → 初始化提示；非交互 → 一次性提问提示。
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

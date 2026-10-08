import { Fragment } from "react";
import { join } from "node:path";
import { Box, Text } from "ink";
import { useInput, useStdin } from "ink";
import { useStore } from "zustand";
import type { UiStore } from "@kcode/ui";
import { InputBox } from "./InputBox.js";
import type { CommandInfo } from "./builtin-commands.js";
import { ToolBrowser } from "../transcript/ToolBrowser.js";
import { TaskBrowser } from "../tasks/TaskBrowser.js";
import { HistorySearch } from "./HistorySearch.js";
import { openInExternalEditor } from "./external-editor.js";
import { readClipboardImageToFile } from "./clipboard-image.js";
import { appendMemoryLine } from "../memory.js";
import { c } from "../theme/theme.js";
import { kcodeHome } from "../../bootstrap.js";

/**
 * 输入区装配（N3C-4②③④⑤⑥）：覆盖层面板打开时顶替输入框——方向键/回车归面板独占，
 * 不与输入光标/历史双响应；这与 DialogLayer"面板顶替 children"的既有模式一致。
 * 其余状态回落：未就绪 → 初始化提示；非交互 → 一次性提问提示。
 * Ctrl+E（外部编辑器）/ Ctrl+R（历史搜索）/ Ctrl+V（贴图附件）在这里处理而非
 * keybinds：三者都需要输入框的值或回填通道；InputBox 自身过滤全部 Ctrl 组合键，
 * 不会双响应。
 */
export function InputArea(props: {
  ui: UiStore;
  ready: boolean;
  interactive: boolean;
  value: string;
  onChange(value: string): void;
  /** 提交；空闲提交携带待发图片附件（N3C-4⑤），排队提交不带（附件留待下一次空闲） */
  onSubmit(value: string, images?: string[]): void;
  history: string[];
  commands: CommandInfo[];
  cwd: string;
  onCjkCommit(): void;
}) {
  const browserOpen = useStore(props.ui, (s) => s.toolBrowser.open);
  const taskBrowserOpen = useStore(props.ui, (s) => s.taskBrowser.open);
  const historySearchOpen = useStore(props.ui, (s) => s.historySearchOpen);
  const pendingImages = useStore(props.ui, (s) => s.pendingImages);
  const busy = useStore(props.ui, (s) => s.busy);
  const { setRawMode } = useStdin();
  const inputActive = props.interactive && props.ready && !browserOpen && !taskBrowserOpen && !historySearchOpen;

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
    { isActive: inputActive && !busy },
  );

  // Ctrl+R 历史搜索覆盖层（空闲/运行中都可查，只读不干扰运行）
  useInput(
    (ch, key) => {
      if (key.ctrl && ch === "r") {
        props.ui.getState().openHistorySearch();
      }
    },
    { isActive: inputActive },
  );

  // Ctrl+V 剪贴板贴图：终端不会传图片数据，经系统 API 读剪贴板落盘为附件
  useInput(
    (ch, key) => {
      if (key.ctrl && ch === "v") {
        void readClipboardImageToFile(join(kcodeHome(), "cli", "tmp")).then((path) => {
          const state = props.ui.getState();
          if (path === null) {
            state.pushBlock({
              kind: "info",
              tone: "warn",
              text: "剪贴板没有可粘贴的图片（当前仅支持 Windows；其他平台可用 --image 附加）",
            });
            return;
          }
          state.addPendingImage(path);
          state.pushBlock({ kind: "info", tone: "ok", text: `📎 已附加剪贴板图片，随下一条消息发送` });
        });
      }
    },
    { isActive: inputActive },
  );

  if (taskBrowserOpen) {
    return <TaskBrowser ui={props.ui} />;
  }
  if (browserOpen) {
    return <ToolBrowser ui={props.ui} />;
  }
  if (historySearchOpen) {
    return <HistorySearch ui={props.ui} history={props.history} onPick={props.onChange} />;
  }
  if (!props.ready) {
    return <Text dimColor>初始化会话…</Text>;
  }
  if (!props.interactive) {
    return <Text dimColor>（非交互模式：仅执行一次性提问后退出）</Text>;
  }
  return (
    <Fragment>
      {pendingImages.length > 0 && (
        <Box marginLeft={2}>
          <Text color={c("warning")}>📎 {pendingImages.length} 张图片附件将随下一条消息发送（Ctrl+V 继续添加）</Text>
        </Box>
      )}
      <InputBox
        value={props.value}
        onChange={props.onChange}
        onSubmit={(v) => {
          // N3G-3：# 开头拦截——追加项目 AGENTS.md（下次会话生效），不进模型不进历史。
          // busy 中同样可用（写文件与会话上下文无争用）
          if (v.startsWith("#")) {
            const note = v.slice(1).trim();
            const state = props.ui.getState();
            props.onChange("");
            if (note === "") {
              state.pushBlock({ kind: "info", tone: "warn", text: "（# 后没有要记住的内容）" });
              return;
            }
            void appendMemoryLine(props.cwd, note).then(
              (path) =>
                state.pushBlock({
                  kind: "info",
                  tone: "ok",
                  text: `📝 已记入 ${path}（下次会话装载，不进本轮上下文）`,
                }),
              (err) =>
                state.pushBlock({
                  kind: "info",
                  tone: "warn",
                  text: `✗ 写入 AGENTS.md 失败：${err instanceof Error ? err.message : String(err)}`,
                }),
            );
            return;
          }
          // 附件只随空闲提交发送：排队不带图（附件保留，避免静默丢失）；
          // 清空时机在 App submit 的守卫之后——exit/空输入不应丢掉已贴的图
          const state = props.ui.getState();
          if (state.busy) {
            props.onSubmit(v);
            return;
          }
          props.onSubmit(v, state.pendingImages.length > 0 ? state.pendingImages : undefined);
        }}
        history={props.history}
        commands={props.commands}
        cwd={props.cwd}
        onCjkCommit={props.onCjkCommit}
      />
    </Fragment>
  );
}

import { Fragment } from "react";
import { join } from "node:path";
import { Box, Text } from "ink";
import { useInput, useStdin } from "ink";
import { useStore } from "zustand";
import type { UiStore } from "@kcode/ui";
import { InputBox } from "./InputBox.js";
import { QueuePanel } from "./QueuePanel.js";
import { CommandPalette, type PaletteAction } from "./CommandPalette.js";
import type { CommandInfo } from "./builtin-commands.js";
import { ToolBrowser } from "../transcript/ToolBrowser.js";
import { TaskBrowser } from "../tasks/TaskBrowser.js";
import { HistorySearch } from "./HistorySearch.js";
import { openInExternalEditor } from "./external-editor.js";
import { readClipboardImageToFile } from "./clipboard-image.js";
import { appendMemoryLine } from "../memory.js";
import { stripEscapes } from "../terminal/sanitize.js";
import { c } from "../theme/theme.js";
import { kcodeHome } from "../../bootstrap.js";

/**
 * 输入区装配（N3C-4②③④⑤⑥）：覆盖层面板打开时顶替输入框——方向键/回车归面板独占，
 * 不与输入光标/历史双响应；这与 DialogLayer"面板顶替 children"的既有模式一致。
 * 其余状态回落：未就绪 → 初始化提示；非交互 → 一次性提问提示。
 * Ctrl+G（外部编辑器）/ Ctrl+R（历史搜索）/ Ctrl+V（贴图附件）在这里处理而非
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
  /** 3-22：会话 JSONL 路径（工具详情展示完整事件位置） */
  jsonlPath?: string;
  /** 3-22：按 callId 读完整工具输出（块内仅 2k 预览） */
  loadToolOutput?: (callId: string) => Promise<string | null>;
  onCjkCommit(): void;
  /** 3-36：命令面板动作（模式循环/中断由 App 注入） */
  onCycleMode?(): void;
  onInterrupt?(): void;
}) {
  const browserOpen = useStore(props.ui, (s) => s.toolBrowser.open);
  const taskBrowserOpen = useStore(props.ui, (s) => s.taskBrowser.open);
  const historySearchOpen = useStore(props.ui, (s) => s.historySearchOpen);
  const paletteOpen = useStore(props.ui, (s) => s.paletteOpen);
  const pendingImages = useStore(props.ui, (s) => s.pendingImages);
  const busy = useStore(props.ui, (s) => s.busy);
  const { setRawMode } = useStdin();
  const inputActive =
    props.interactive && props.ready && !browserOpen && !taskBrowserOpen && !historySearchOpen && !paletteOpen;

  // 3-24：外部编辑长输入迁到 Ctrl+G（Ctrl+E 让位给行尾），仅空闲可用
  // （spawnSync 阻塞事件循环，运行中会冻结流式渲染）
  useInput(
    (ch, key) => {
      if (key.ctrl && ch === "g") {
        void openInExternalEditor(props.value, {
          suspend: () => setRawMode(false),
          resume: () => setRawMode(true),
        }).then((result) => {
          if (result.ok) {
            if (result.text !== props.value) {
              // 外部编辑器写回的内容同样按不可信文本处理（3-26）
              props.onChange(stripEscapes(result.text));
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

  // 3-36：Ctrl+K 命令面板（内置命令 + 自定义命令 + 键动作，模糊过滤）
  useInput(
    (ch, key) => {
      if (key.ctrl && ch === "k") {
        props.ui.getState().openPalette();
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

  if (paletteOpen) {
    const noArg = (hint: string | undefined): boolean =>
      hint === undefined || hint.startsWith("（无参数") || hint.startsWith("(无参数");
    const actions: PaletteAction[] = [
      {
        id: "action:tools",
        label: "打开工具浏览器",
        description: "长输出分页 / 搜索 / 复制（Ctrl+B）",
        kind: "动作",
        run: () => props.ui.getState().openToolBrowser(),
      },
      {
        id: "action:tasks",
        label: "打开后台任务",
        description: "运行中任务、日志尾部与停止（Ctrl+T）",
        kind: "动作",
        run: () => props.ui.getState().openTaskBrowser(),
      },
      {
        id: "action:history",
        label: "历史输入搜索",
        description: "跨会话输入历史（Ctrl+R）",
        kind: "动作",
        run: () => props.ui.getState().openHistorySearch(),
      },
      ...(props.onCycleMode !== undefined
        ? [
            {
              id: "action:mode",
              label: "切换权限模式",
              description: "plan / default / acceptEdits（Shift+Tab）",
              kind: "动作" as const,
              run: () => props.onCycleMode?.(),
            },
          ]
        : []),
      ...(busy && props.onInterrupt !== undefined
        ? [
            {
              id: "action:interrupt",
              label: "中断当前运行",
              description: "停止本轮（队列保留）",
              kind: "动作" as const,
              run: () => props.onInterrupt?.(),
            },
          ]
        : []),
      ...props.commands.map((command) => ({
        id: `cmd:${command.name}`,
        label: `/${command.name}`,
        description: command.desc,
        ...(command.argsHint !== undefined ? { hint: command.argsHint } : {}),
        kind: "命令" as const,
        run: () => {
          if (noArg(command.argsHint) && !props.ui.getState().busy) {
            props.onSubmit(`/${command.name}`);
          } else {
            props.onChange(`/${command.name} `);
          }
        },
      })),
    ];
    return <CommandPalette actions={actions} onClose={() => props.ui.getState().closePalette()} />;
  }
  if (taskBrowserOpen) {
    return <TaskBrowser ui={props.ui} />;
  }
  if (browserOpen) {
    return (
      <ToolBrowser
        ui={props.ui}
        {...(props.jsonlPath !== undefined ? { jsonlPath: props.jsonlPath } : {})}
        {...(props.loadToolOutput !== undefined ? { loadOutput: props.loadToolOutput } : {})}
      />
    );
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
      <QueuePanel ui={props.ui} />
      {pendingImages.length > 0 && (
        <Box marginLeft={2}>
          <Text color={c("warning")}>📎 {pendingImages.length} 张图片附件将随下一条消息发送（Ctrl+V 继续添加）</Text>
        </Box>
      )}
      <InputBox
        value={props.value}
        onChange={props.onChange}
        onSubmit={(v) => {
          // 3-28：# 记忆只认 "# "（井号 + 空格）——`#include`、`#123`、Markdown 标题
          // 不再被误写进 AGENTS.md；裸 # 按普通提问发送（可编辑性优先）。
          if (v.startsWith("# ")) {
            const note = v.slice(2).trim();
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

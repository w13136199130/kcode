import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useStdin, useStdout } from "ink";
import { previousBoundary, nextBoundary } from "../terminal/width.js";
import { onHomeEnd, patchStdinReadForKeys } from "../terminal/home-end-tee.js";
import { appendInputLog } from "../terminal/input-log.js";
import { filterFileCandidates, listProjectFiles } from "./file-complete.js";
import { UndoStack } from "./undo.js";
import { GHOST_HINT } from "./suggestions.js";
import { c } from "../theme/theme.js";
import type { CommandInfo } from "./builtin-commands.js";

/**
 * 输入框（仅交互 TTY 挂载）：
 * - 输入 / 开头时弹出命令补全菜单（↑↓ 选择、Tab/回车补全、继续输入过滤）；
 * - 无菜单时 ↑↓ 翻阅输入历史（最近 50 条）：首翻暂存草稿，下翻到底恢复。
 */
/** Ink 在 effect 中订阅输入；稳定订阅读取最新处理器，避免提交帧后仍使用旧草稿。 */
function useLiveInput(handler: Parameters<typeof useInput>[0], options: Parameters<typeof useInput>[1]): void {
  const { stdin } = useStdin();
  useEffect(() => {
    // Ink 5 将 DEL 退格与 Delete 合并；在解析前只归一化独立 DEL，
    // 保留 Delete 的 ESC[3~ 及粘贴文本，避免光标在行中时删除错误方向。
    const original = stdin.read;
    const read: typeof stdin.read = function (size) {
      const chunk: unknown = original.call(stdin, size);
      return chunk === "\x7f" ? "\b" : chunk;
    };
    stdin.read = read;
    return () => { if (stdin.read === read) stdin.read = original; };
  }, [stdin]);
  const latest = useRef(handler);
  latest.current = handler;
  useInput(useCallback((text, key) => latest.current(text, key), []), options);
}

export function InputBox(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  history: string[];
  commands: CommandInfo[];
  /** @ 补全的项目根目录 */
  cwd: string;
  /** 空态起步建议（N3G-4）：非空且输入为空时数字键 1..n 直接填入（填入不提交） */
  starters?: readonly string[];
  onCjkCommit?: () => void;
}) {
  const draft = useRef("");
  const index = useRef(-1);
  // 菜单高亮必须是 state：ref 变更不触发重渲染（高亮会「冻结」，表现为方向键失灵）
  const [menuIndex, setMenuIndex] = useState(0);
  /**
   * 光标以「绑定值」形式存储：仅当 cursor.for 与当前 value 一致时才生效，
   * 外部改值（提交清空/历史回填）自动失效回末尾——纯派生计算，
   * 不做任何渲染期 setState（渲染期 setState 会让 Ink 提交空帧 = 不回显）。
   */
  const [cursor, setCursor] = useState<{ for: string; at: number } | null>(null);
  const pos =
    cursor !== null && cursor.for === props.value
      ? Math.min(cursor.at, props.value.length)
      : props.value.length;
  const latestValue = useRef(props.value);
  latestValue.current = props.value;
  useEffect(() => {
    // 提交后 InputBox 重挂载：首帧可能被终端/上一轮输出覆盖，挂载即请求一次重绘
    props.onCjkCommit?.();
    // Home/End 被 Ink 的具名键清空机制丢弃：经 stdin.read tee 回收
    patchStdinReadForKeys();
    const off = onHomeEnd((k) => {
      if (k === "home") {
        setCursor({ for: latestValue.current, at: 0 });
      } else {
        setCursor(null);
      }
    });
    return () => {
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setValue = (v: string, at?: number): void => {
    props.onChange(v);
    setCursor(at !== undefined ? { for: v, at } : null);
  };

  // N3G-2 undo/redo：快照双栈 + 100ms 合并。所有值变化（含外部：提交清空/
  // 编辑器替换）都经此 effect 记录；undo/redo 自身改值时置 skip 不记录。
  const undoStack = useRef(new UndoStack()).current;
  const skipRecord = useRef(false);
  /** 边界事件标记（提交/多字符插入/历史回填）：下一跳变跳过合并窗口 */
  const boundary = useRef(false);
  const prevValue = useRef(props.value);
  useEffect(() => {
    if (props.value === prevValue.current) {
      return;
    }
    if (!skipRecord.current) {
      undoStack.push(prevValue.current, boundary.current);
    }
    skipRecord.current = false;
    boundary.current = false;
    prevValue.current = props.value;
  }, [props.value, undoStack]);
  const applyUndoValue = (v: string | null): void => {
    if (v === null || v === props.value) {
      return;
    }
    skipRecord.current = true;
    setValue(v);
  };

  // 终端没有可靠的 DOM composition 事件：保留收到的文字，不猜拼音，不丢数字。
  const insertText = (str: string): void => {
    const text = str.replace(/\r\n?/g, "\n");
    // 多字符一次到位 = 粘贴或 IME 上屏：各自成撤销单元（IME 组合过程终端不上报）
    if (text.length > 1) {
      boundary.current = true;
    }
    setValue(props.value.slice(0, pos) + text + props.value.slice(pos), pos + text.length);
  };
  const menuOpen =
    props.value.startsWith("/") && !props.value.includes(" ") && props.value.length >= 1;
  const needle = props.value.slice(1).toLowerCase();
  const matches = menuOpen
    ? props.commands.filter((c) => c.name.toLowerCase().startsWith(needle))
    : [];
  const showMenu = matches.length > 0;
  const clamped = Math.min(menuIndex, Math.max(0, matches.length - 1));
  /** @ 文件补全（B4）：光标前「@query」触发；菜单与命令补全互斥（命令态以 / 开头） */
  const [fileMenu, setFileMenu] = useState<{ items: string[]; index: number } | null>(null);
  const fileList = useRef<string[] | null>(null);
  useEffect(() => {
    const before = props.value.slice(0, pos);
    const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (m === null || menuOpen) {
      setFileMenu(null);
      return;
    }
    void (async () => {
      if (fileList.current === null) {
        fileList.current = await listProjectFiles(props.cwd);
      }
      const items = filterFileCandidates(fileList.current, m[1] ?? "");
      setFileMenu(items.length > 0 ? { items, index: 0 } : null);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value, pos, menuOpen]);
  /** 把候选路径替换掉光标前的 @query */
  const insertFileCandidate = (path: string): void => {
    const before = props.value.slice(0, pos);
    const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (m === null) {
      setFileMenu(null);
      return;
    }
    const keep = before.length - m[0].length;
    const leading = m[0].startsWith(" ") ? " " : "";
    const inserted = `${leading}${path} `;
    setValue(`${props.value.slice(0, keep)}${inserted}${props.value.slice(pos)}`, keep + inserted.length);
    setFileMenu(null);
  };
  // 过滤词变化即重置高亮（渲染期调整 state 的标准模式）
  // 单一 Ink 输入通道：字符/IME 整串/方向/回车/退格全在此处理。
  // Home/End 在 Ink 的 key 对象里未暴露，以序列形式到达（[H 被剥掉 ESC 后成 "[H"）。
  useLiveInput(
    (ch, key) => {
      if (process.env["KCODE_INPUT_DEBUG"] === "1") {
        try {
          appendInputLog(`ch=${JSON.stringify(ch)} key=${JSON.stringify(key)}`);
        } catch {}
      }

      // N3G-2：Ctrl+Z 撤销 / Ctrl+Y 与 Ctrl+Shift+Z（能区分的终端）重做——
      // 必须在通用 ctrl 早退之前；全局 keybinds 未占用这三个组合
      if (key.ctrl && (ch === "z" || ch === "Z" || ch === "y")) {
        if (ch === "z") {
          applyUndoValue(undoStack.undo(props.value));
        } else {
          applyUndoValue(undoStack.redo(props.value));
        }
        return;
      }
      if (key.ctrl) {
        return; // 组合键（Ctrl+C 等）由 App 层处理
      }
      // Shift+Enter 换行（对标 Claude Code）：仅 kitty/modifyOtherKeys 终端可与 Enter 区分，
      // 普通终端发的是同一个 \r（等价 Enter 提交）——可移植路径仍是 Ctrl+J / 行尾反斜杠
      if (key.return === true && key.shift === true) {
        setValue(`${props.value.slice(0, pos)}\n${props.value.slice(pos)}`, pos + 1);
        return;
      }
      if (fileMenu !== null) {
        if (key.upArrow) {
          setFileMenu({ ...fileMenu, index: (fileMenu.index - 1 + fileMenu.items.length) % fileMenu.items.length });
          return;
        }
        if (key.downArrow) {
          setFileMenu({ ...fileMenu, index: (fileMenu.index + 1) % fileMenu.items.length });
          return;
        }
        if (key.tab || key.return) {
          insertFileCandidate(fileMenu.items[fileMenu.index] ?? fileMenu.items[0]!);
          return;
        }
        if (key.escape) {
          setFileMenu(null);
          return;
        }
        // 其余按键落入正常输入处理（继续输入即实时过滤）
      }
      if (showMenu) {
        if (key.upArrow) {
          setMenuIndex((s) => (s - 1 + matches.length) % matches.length);
        } else if (key.downArrow) {
          setMenuIndex((s) => (s + 1) % matches.length);
        } else if (key.tab || (key.return && ch !== "\n")) {
          const picked = matches[clamped] ?? matches[0];
          if (picked !== undefined) {
            setValue(`/${picked.name} `);
          }
        } else if (key.escape) {
          boundary.current = true; // 菜单 Esc 清空：整段草稿一个撤销单元
          setValue("");
        } else if (key.backspace) {
          if (pos > 0) {
            setValue(`${props.value.slice(0, previousBoundary(props.value, pos))}${props.value.slice(pos)}`, previousBoundary(props.value, pos));
          }
        } else if (key.delete) {
          if (pos < props.value.length) {
            setValue(`${props.value.slice(0, pos)}${props.value.slice(nextBoundary(props.value, pos))}`, pos);
          }
        } else if (key.leftArrow) {
          setCursor({ for: props.value, at: Math.max(0, previousBoundary(props.value, pos)) });
        } else if (key.rightArrow) {
          setCursor({ for: props.value, at: Math.min(props.value.length, nextBoundary(props.value, pos)) });
        } else if (ch !== "" && !key.escape && !key.return && !key.tab) {
          insertText(ch);
        }
        return;
      }
      if (key.upArrow) {
        if (props.history.length === 0) return;
        if (index.current === -1) {
          draft.current = props.value;
          index.current = props.history.length - 1;
        } else if (index.current > 0) {
          index.current -= 1;
        }
        boundary.current = true; // 历史回填是大跳变：独立撤销单元（误触方向键可找回草稿）
        props.onChange(props.history[index.current] ?? "");
      } else if (key.downArrow) {
        if (index.current === -1) return;
        if (index.current < props.history.length - 1) {
          index.current += 1;
          boundary.current = true;
          props.onChange(props.history[index.current] ?? "");
        } else {
          index.current = -1;
          boundary.current = true;
          props.onChange(draft.current);
        }
      } else if (key.leftArrow) {
        setCursor({ for: props.value, at: Math.max(0, previousBoundary(props.value, pos)) });
      } else if (key.rightArrow) {
        setCursor({ for: props.value, at: Math.min(props.value.length, nextBoundary(props.value, pos)) });
      } else if (key.backspace) {
        if (pos > 0) {
          setValue(`${props.value.slice(0, previousBoundary(props.value, pos))}${props.value.slice(pos)}`, previousBoundary(props.value, pos));
        }
      } else if (key.delete) {
        if (pos < props.value.length) {
          setValue(`${props.value.slice(0, pos)}${props.value.slice(nextBoundary(props.value, pos))}`, pos);
        }
      } else if (key.return) {
        if (ch === "\n") {
          // Ctrl+J（LF）：显式换行——多行输入主入口。Enter 发 \r、Ctrl+J 发 \n，
          // raw 模式下终端恒可区分；粘贴多行文本的换行符也走此路径（不会提前提交）
          setValue(`${props.value.slice(0, pos)}\n${props.value.slice(pos)}`, pos + 1);
        } else if (pos === props.value.length && props.value.endsWith("\\") && props.value.length > 1) {
          // 行尾反斜杠 + 回车 = 续行（shell 习惯）：\ 换成换行符，不提交
          setValue(`${props.value.slice(0, -1)}\n`, pos);
        } else {
          boundary.current = true; // 提交后外部清空是独立撤销单元（误触回车可 Ctrl+Z 找回草稿）
          props.onSubmit(props.value);
        }
      } else if (
        props.starters !== undefined &&
        props.value === "" &&
        (ch === "1" || ch === "2" || ch === "3") &&
        Number(ch) <= props.starters.length
      ) {
        // N3G-4：空态数字快捷填入（填入不提交——过目后回车）
        boundary.current = true;
        setValue(props.starters[Number(ch) - 1]!);
      } else if (ch !== "" && !key.escape && !key.tab) {
        // 可打印字符 / IME 提交的整串
        insertText(ch);
      }
    },
    { isActive: true },
  );
  // 布局对标 Claude Code：菜单在上方 → ── 分隔线 → 输入行（必须是帧的最后一行，
  // 帧渲染后光标锚定回输入行，IME 组合窗随之显示在 > 后面）
  // 输入行渲染为纯扁平字符串（before + █ 光标 + after）：
  // 嵌套 <Text inverse> 子节点在快速连续变更（退格→上屏）下触发 Ink 内部丢失 CJK（已最小复现），
  // 扁平字符串路径经同一复现用例验证无恙。多行时按 \n 拆行、每行独立扁平 <Text>（续行缩进两格）。
  const lines = props.value.split("\n");
  let cursorLine = lines.length - 1;
  let cursorCol = lines[lines.length - 1] !== undefined ? lines[lines.length - 1]!.length : 0;
  {
    let acc = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (pos <= acc + line.length) {
        cursorLine = i;
        cursorCol = pos - acc;
        break;
      }
      acc += line.length + 1;
    }
  }
  // 布局：菜单（上方）→ 上分割线 → 输入行（可多行）→ 下分割线。
  const { stdout: out } = useStdout();
  const separator = "─".repeat(Math.max(20, (out.columns ?? 80) - 1));
  return (
    <Box flexDirection="column">
      {showMenu && (
        <Box flexDirection="column">
          {matches.slice(0, 8).map((cmd, i) => (
            <Text
              key={cmd.name}
              color={i === clamped ? c("brand") : undefined}
              bold={i === clamped}
            >
              {i === clamped ? "❯ /" : "  /"}
              {cmd.name}
              <Text dimColor={i !== clamped}>  {cmd.desc}</Text>
            </Text>
          ))}
          <Text dimColor>↑↓ 选择 · Tab/回车 补全 · Esc 关闭 · ↑↓(无菜单) 翻历史</Text>
        </Box>
      )}
      {fileMenu !== null && (
        <Box flexDirection="column">
          {fileMenu.items.map((f, i) => (
            <Text key={f} color={i === fileMenu.index ? c("brand") : undefined} bold={i === fileMenu.index}>
              {i === fileMenu.index ? "❯ @" : "  @"}
              {f}
            </Text>
          ))}
          <Text dimColor>↑↓ 选择 · Tab/回车 插入路径 · Esc 关闭</Text>
        </Box>
      )}
      <Text dimColor>{separator}</Text>
      <Box flexDirection="column">
        {lines.map((line, i) => {
          const active = i === cursorLine;
          const content = active
            ? `${line.slice(0, cursorCol)}█${line.slice(cursorCol)}`
            : line;
          return (
            <Box key={i}>
              <Text dimColor>{i === 0 ? "> " : "  "}</Text>
              <Text>{content.length > 0 ? content : " "}</Text>
              {active && props.value === "" && <Text dimColor>{GHOST_HINT}</Text>}
            </Box>
          );
        })}
      </Box>
      <Text dimColor>{separator}</Text>
    </Box>
  );
}

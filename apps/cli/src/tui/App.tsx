import { useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import type {
  AskPreviewPayload,
  PermissionAnswer,
  PermissionMode,
  PermissionAsker,
  SessionEvent,
  StructuredQuestion,
  TodoItem,
  ToolCallRef,
  UserPromptPort,
} from "@kcode/contracts";
import { EncryptedFileKeychain } from "@kcode/platform";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { killDaemonByPidfile, type DaemonClient } from "../daemon-client.js";
import { kcodeHome, saveUserModelsConfig } from "../bootstrap.js";
import { createSession } from "../session.js";
import { BlockView, TodoPanel, formatToolPreview, visualWidth, type Block } from "./Transcript.js";
import { onHomeEnd, patchStdinReadForKeys } from "./home-end-tee.js";

export interface KcodeAppProps {
  /** 守护进程连接：会话在守护进程侧组装与执行 */
  client: DaemonClient;
  model: string;
  cwd: string;
  /** 一次性提问（非交互/脚本模式）；缺省进 REPL */
  oneShot?: string;
  /** 一次性提问附图（本地文件路径，多模态输入） */
  images?: string[];
  /** 续接来源（会话 id / 前缀 / latest，由守护进程解析重建） */
  resumeFrom?: string;
}

/** 四档权限模式的界面元数据（与 extensions/RULES_BY_MODE 一一对应）；符号用等宽字形不用 emoji */
const MODE_META: Record<PermissionMode, { label: string; hint: string; color: string }> = {
  plan: { label: "只读", hint: "写/命令将被拒绝", color: "magenta" },
  default: { label: "变更确认", hint: "写/命令逐次确认", color: "cyan" },
  acceptEdits: { label: "自动编辑", hint: "编辑自动放行，命令仍确认", color: "green" },
  fullAccess: { label: "完全访问", hint: "全自动，谨慎使用", color: "red" },
};

/** spinner 动词池（每轮随机取一，对标 Claude Code 的 Crunching/Pondering） */
const SPIN_VERBS = ["思考中", "推敲中", "检索中", "整理中", "研磨中", "推演中"];

/** /mode 循环切换顺序：fullAccess 不进循环，只能显式指定并确认 */
const MODE_CYCLE: PermissionMode[] = ["plan", "default", "acceptEdits"];

interface AskState {
  call: ToolCallRef & { preview?: AskPreviewPayload };
  resolve: (answer: PermissionAnswer) => void;
}

interface QuestionState {
  question: StructuredQuestion;
  resolve: (labels: string[]) => void;
}

/** /login 向导的厂商预设（OpenAI 兼容端点） */
const LOGIN_PRESETS: Array<{
  key: string;
  name: string;
  label: string;
  baseURL: string;
  model: string;
}> = [
  {
    key: "1",
    name: "glm",
    label: "智谱 BigModel（glm-5.3）",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.3",
  },
  {
    key: "2",
    name: "deepseek",
    label: "DeepSeek（deepseek-chat）",
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  },
  {
    key: "3",
    name: "kimi",
    label: "Moonshot Kimi（kimi-k2）",
    baseURL: "https://api.moonshot.cn/v1",
    model: "kimi-k2",
  },
  { key: "4", name: "custom", label: "自定义 OpenAI 兼容端点（自行填写地址与模型名）", baseURL: "", model: "" },
];

type LoginWizard =
  | null
  | {
      stage: "method" | "model" | "baseURL" | "apikey" | "passphrase";
      providerName: string;
      presetBaseURL: string;
      presetModel: string;
      baseURL: string;
      apiKey: string;
      model: string;
    };

/** 内置命令清单（/ 自动补全菜单数据源；自定义命令由会话注入合并） */
export interface CommandInfo {
  name: string;
  desc: string;
}

const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: "mode", desc: "切换权限模式（plan/default/acceptEdits/fullAccess）" },
  { name: "model", desc: "查看/切换模型（选择菜单）" },
  { name: "login", desc: "配置模型厂商与 API key（向导）" },
  { name: "skills", desc: "查看已装载技能" },
  { name: "skill", desc: "手动注入技能正文" },
  { name: "sessions", desc: "最近会话列表" },
  { name: "plan", desc: "计划模式快捷切换" },
  { name: "trust", desc: "信任当前项目" },
  { name: "help", desc: "显示帮助" },
  { name: "exit", desc: "退出" },
];

/** /model 选择菜单状态 */
type ModelPicker = null | { options: MenuOption[] };

/** 隐藏回显输入（API key / 口令） */
function HiddenInput(props: { label: string; onDone: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState("");
  useInput((ch, key) => {
    if (key.return) {
      props.onDone(value);
      return;
    }
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.backspace || key.delete) {
      setValue((s) => s.slice(0, -1));
      return;
    }
    if (ch !== undefined && ch !== "" && ch >= " ") {
      setValue((s) => s + ch);
    }
  });
  return (
    <Text>
      <Text color="magenta">{props.label}</Text>
      {"•".repeat(value.length)}
    </Text>
  );
}

/** 带标签的文本输入（向导 baseURL/模型名） */
function PromptInput(props: {
  label: string;
  initialValue: string;
  onDone: (v: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.initialValue);
  useInput((_ch, key) => {
    if (key.escape) {
      props.onCancel();
    }
  });
  return (
    <Box>
      <Text color="magenta">{props.label}</Text>
      <TextInput value={value} onChange={setValue} onSubmit={props.onDone} />
    </Box>
  );
}

/** 输入事件调试日志：设 KCODE_INPUT_DEBUG=1 后写入 ~/kcode-input.log（排查终端差异用） */
function appendInputLog(line: string): void {
  try {
    appendFileSync(join(homedir(), "kcode-input.log"), `${Date.now()} ${line}\n`, "utf8");
  } catch {
    // 调试日志失败静默
  }
}

export interface MenuOption {
  /** 快捷键（单选时按下即选中并确认；多选时忽略） */
  key: string;
  label: string;
}

/**
 * 方向键选项菜单（对标 Claude Code 权限确认交互）：
 * ↑↓ 移动高亮（按键输入实时可见），回车确认选中项，Esc 取消；
 * 单选模式数字/快捷键直达，多选模式空格切换勾选。
 */
function OptionsMenu(props: {
  options: MenuOption[];
  multi?: boolean;
  /** 初始高亮项（危险操作默认停在取消项） */
  initialIndex?: number;
  onPick: (indices: number[]) => void;
  onCancel: () => void;
}) {
  const count = props.options.length;
  const [selected, setSelected] = useState(props.initialIndex ?? 0);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  // 单一 Ink 输入通道（与 stdin 的读取模式不再打架——私加 data 监听会饿死 Ink 的 readable 循环）
  useInput((ch, key) => {
    if (key.upArrow) {
      setSelected((s) => (s - 1 + count) % count);
      return;
    }
    if (key.downArrow) {
      setSelected((s) => (s + 1) % count);
      return;
    }
    if (key.return) {
      if (props.multi === true) {
        props.onPick([...checked]);
      } else {
        props.onPick([selected]);
      }
      return;
    }
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (props.multi === true && ch === " ") {
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(selected)) {
          next.delete(selected);
        } else {
          next.add(selected);
        }
        return next;
      });
      return;
    }
    if (props.multi !== true) {
      const idx = props.options.findIndex((o) => o.key === ch.toLowerCase());
      if (idx !== -1) {
        props.onPick([idx]);
      }
    }
  });
  return (
    <Box flexDirection="column">
      {props.options.map((o, i) => {
        const highlighted = i === selected;
        const marker =
          props.multi === true ? (checked.has(i) ? "☒" : "☐") : highlighted ? "❯" : " ";
        return (
          <Text key={o.key} color={highlighted ? "cyan" : undefined} bold={highlighted}>
            {marker} {i + 1}. {o.label}
          </Text>
        );
      })}
      <Text dimColor>
        {props.multi === true
          ? " ↑↓ 移动 · 空格勾选 · 回车确认 · Esc 取消"
          : " ↑↓/数字 选择 · 回车确认 · Esc 取消"}
      </Text>
    </Box>
  );
}

/** diff 预览行渲染：- 红 / + 绿 / 上下文 dim；行数超限截断 */
const PREVIEW_MAX_LINES = 20;

function DiffPreview(props: { preview: AskPreviewPayload }) {
  const lines = props.preview.diff.split("\n");
  const shown = lines.slice(0, PREVIEW_MAX_LINES);
  return (
    <Box flexDirection="column">
      {props.preview.path !== undefined && (
        <Text color="cyan" bold>
          {"  "}
          {props.preview.path}
        </Text>
      )}
      {shown.map((line, i) => (
        <Text
          key={i}
          color={line.startsWith("+") ? "green" : line.startsWith("-") ? "red" : undefined}
          dimColor={!line.startsWith("+") && !line.startsWith("-")}
        >
          {"  "}
          {line.slice(0, 120)}
        </Text>
      ))}
      {lines.length > PREVIEW_MAX_LINES && (
        <Text dimColor>
          {"  "}…（共 {lines.length} 行，已截断）
        </Text>
      )}
    </Box>
  );
}

/**
 * 输入框（仅交互 TTY 挂载）：
 * - 输入 / 开头时弹出命令补全菜单（↑↓ 选择、Tab/回车补全、继续输入过滤）；
 * - 无菜单时 ↑↓ 翻阅输入历史（最近 50 条）：首翻暂存草稿，下翻到底恢复。
 */
export function InputBox(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  history: string[];
  commands: CommandInfo[];
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
  /** IME 组合区起点（连续 [a-z0-9'] 拼音输入的起始下标；null = 无组合区） */
  const [pinyinTailStart, setPinyinTailStart] = useState<number | null>(null);
  const pos =
    cursor !== null && cursor.for === props.value
      ? Math.min(cursor.at, props.value.length)
      : props.value.length;
  useEffect(() => {
    // 提交后 InputBox 重挂载：首帧可能被终端/上一轮输出覆盖，挂载即请求一次重绘
    props.onCjkCommit?.();
    // Home/End 被 Ink 的具名键清空机制丢弃：经 stdin.read tee 回收
    patchStdinReadForKeys();
    const off = onHomeEnd((k) => {
      if (k === "home") {
        trimTailTo(0);
        setCursor({ for: props.value, at: 0 });
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

  /**
   * IME 组合区跟踪：终端把组合期的拼音键（含音节分隔符 '）逐个漏给应用，
   * 连续的 [a-z0-9'] 记为组合区；中文上屏时把整个组合区替换为中文
   * （对标 Claude Code：组合期显示拼音，选词后干净替换）。
   * 任何非组合输入（大写/符号/退格/删除/光标跳转/历史/补全）重置组合区。
   */
  const clearTail = (): void => {
    if (pinyinTailStart !== null) {
      setPinyinTailStart(null);
    }
  };
  /** 光标移到 newPos 后组合区是否仍有效（组合期内退格=编辑拼音，不应作废整个组合区） */
  const trimTailTo = (newPos: number): void => {
    if (pinyinTailStart !== null && newPos < pinyinTailStart) {
      setPinyinTailStart(null);
    }
  };

  /** 最近一次中文上屏时刻：候选选择的数字键可能晚于中文到达（conhost 竞态），短窗口内丢弃 */
  const lastCjkAt = useRef(0);

  const insertText = (str: string): void => {
    if (process.env["KCODE_INPUT_DEBUG"] === "1") {
      try {
        appendInputLog(`insert str=${JSON.stringify(str)} pos=${pos} value=${JSON.stringify(props.value)} tail=${pinyinTailStart}`);
      } catch {}
    }
    const base = props.value;
    const at = pos;
    // 候选数字泄漏防护：中文上屏后 1.2s 内的孤立数字是选词键泄漏/二次按压，丢弃
    // （日志实测二次按压间隔 663~1313ms）
    if (/^[0-9]$/.test(str) && Date.now() - lastCjkAt.current < 1200) {
      return;
    }
    // 组合期按键：延续或新开组合区
    if (/^[a-z0-9']$/.test(str)) {
      const start = pinyinTailStart !== null && pinyinTailStart <= at ? pinyinTailStart : at;
      setPinyinTailStart(start);
      setValue(`${base.slice(0, at)}${str}${base.slice(at)}`, at + str.length);
      return;
    }
    const hasCjk = /[一-鿿　-〿！-～]/.test(str);
    if (hasCjk) {
      lastCjkAt.current = Date.now();
      props.onCjkCommit?.();
    }
    if (hasCjk && pinyinTailStart !== null && pinyinTailStart <= at) {
      // 上屏替换：整个组合区换成本次的中文串
      const replacedBase = base.slice(0, pinyinTailStart) + base.slice(at);
      setPinyinTailStart(null);
      setValue(`${replacedBase.slice(0, pinyinTailStart)}${str}${replacedBase.slice(pinyinTailStart)}`, pinyinTailStart + str.length);
      return;
    }
    setPinyinTailStart(null);
    setValue(`${base.slice(0, at)}${str}${base.slice(at)}`, at + str.length);
  };
  const menuOpen =
    props.value.startsWith("/") && !props.value.includes(" ") && props.value.length >= 1;
  const needle = props.value.slice(1).toLowerCase();
  const matches = menuOpen
    ? props.commands.filter((c) => c.name.toLowerCase().startsWith(needle))
    : [];
  const showMenu = matches.length > 0;
  const clamped = Math.min(menuIndex, Math.max(0, matches.length - 1));
  // 过滤词变化即重置高亮（渲染期调整 state 的标准模式）
  // 单一 Ink 输入通道：字符/IME 整串/方向/回车/退格全在此处理。
  // Home/End 在 Ink 的 key 对象里未暴露，以序列形式到达（[H 被剥掉 ESC 后成 "[H"）。
  useInput(
    (ch, key) => {
      if (process.env["KCODE_INPUT_DEBUG"] === "1") {
        try {
          appendInputLog(`ch=${JSON.stringify(ch)} key=${JSON.stringify(key)}`);
        } catch {}
      }
      if (process.env["VITEST"] === "true") {
        // eslint-disable-next-line no-console
        console.error("DBG handler", JSON.stringify(ch), JSON.stringify(key).slice(0, 80));
      }
      if (key.ctrl) {
        return; // 组合键（Ctrl+C 等）由 App 层处理
      }
      if (showMenu) {
        if (key.upArrow) {
          setMenuIndex((s) => (s - 1 + matches.length) % matches.length);
        } else if (key.downArrow) {
          setMenuIndex((s) => (s + 1) % matches.length);
        } else if (key.tab || key.return) {
          const picked = matches[clamped] ?? matches[0];
          if (picked !== undefined) {
            setValue(`/${picked.name} `);
          }
        } else if (key.escape) {
          setValue("");
        } else if (key.backspace) {
          if (pos > 0) {
            trimTailTo(pos - 1);
            setValue(`${props.value.slice(0, pos - 1)}${props.value.slice(pos)}`, pos - 1);
          }
        } else if (key.delete) {
          // 中文 Windows 控制台的退格键发来 delete(0x7f)而非 backspace；
          // 行尾时向前无字符，退化为向后删（与其他 CLI 的键码归一化一致）
          if (pos < props.value.length) {
            trimTailTo(pos);
            setValue(`${props.value.slice(0, pos)}${props.value.slice(pos + 1)}`, pos);
          } else if (pos > 0) {
            trimTailTo(pos - 1);
            setValue(`${props.value.slice(0, pos - 1)}${props.value.slice(pos)}`, pos - 1);
          }
        } else if (key.leftArrow) {
          trimTailTo(pos - 1);
          setCursor({ for: props.value, at: Math.max(0, pos - 1) });
        } else if (key.rightArrow) {
          trimTailTo(pos + 1);
          setCursor({ for: props.value, at: Math.min(props.value.length, pos + 1) });
        } else if (ch !== "" && !key.escape && !key.return && !key.tab) {
          insertText(ch);
        }
        return;
      }
      if (key.upArrow) {
        if (props.history.length === 0) return;
        clearTail();
        if (index.current === -1) {
          draft.current = props.value;
          index.current = props.history.length - 1;
        } else if (index.current > 0) {
          index.current -= 1;
        }
        props.onChange(props.history[index.current] ?? "");
      } else if (key.downArrow) {
        if (index.current === -1) return;
        clearTail();
        if (index.current < props.history.length - 1) {
          index.current += 1;
          props.onChange(props.history[index.current] ?? "");
        } else {
          index.current = -1;
          props.onChange(draft.current);
        }
      } else if (key.leftArrow) {
        trimTailTo(pos - 1);
        setCursor({ for: props.value, at: Math.max(0, pos - 1) });
      } else if (key.rightArrow) {
        trimTailTo(pos + 1);
        setCursor({ for: props.value, at: Math.min(props.value.length, pos + 1) });
      } else if (key.backspace) {
        if (pos > 0) {
          trimTailTo(pos - 1);
          setValue(`${props.value.slice(0, pos - 1)}${props.value.slice(pos)}`, pos - 1);
        }
      } else if (key.delete) {
        // 同上：delete 行尾退化为向后删（退格键在中文控制台走此分支）
        if (pos < props.value.length) {
          trimTailTo(pos);
          setValue(`${props.value.slice(0, pos)}${props.value.slice(pos + 1)}`, pos);
        } else if (pos > 0) {
          trimTailTo(pos - 1);
          setValue(`${props.value.slice(0, pos - 1)}${props.value.slice(pos)}`, pos - 1);
        }
      } else if (key.return) {
        props.onSubmit(props.value);
      } else if (ch !== "" && !key.escape && !key.tab) {
        // 可打印字符 / IME 提交的整串（含中文替换拼音）
        insertText(ch);
      }
    },
    { isActive: true },
  );
  // 布局对标 Claude Code：菜单在上方 → ── 分隔线 → 输入行（必须是帧的最后一行，
  // 帧渲染后光标锚定回输入行，IME 组合窗随之显示在 > 后面）
  // 输入行渲染为纯扁平单字符串（before + █ 光标 + after）：
  // 嵌套 <Text inverse> 子节点在快速连续变更（退格→上屏）下触发 Ink 内部丢失 CJK（已最小复现），
  // 扁平字符串路径经同一复现用例验证无恙。
  const inputDisplay = `${props.value.slice(0, pos)}█${props.value.slice(pos + 1)}`;
  // 布局：菜单（上方）→ 上分割线 → 输入行 → 下分割线。
  // 输入行下方恒定只有底部分割线 1 行——IME 光标锚定的恒定偏移前提。
  const { stdout: out } = useStdout();
  const separator = "─".repeat(Math.max(20, (out.columns ?? 80) - 1));
  return (
    <Box flexDirection="column">
      {showMenu && (
        <Box flexDirection="column">
          {matches.slice(0, 8).map((c, i) => (
            <Text
              key={c.name}
              color={i === clamped ? "cyan" : undefined}
              bold={i === clamped}
            >
              {i === clamped ? "❯ /" : "  /"}
              {c.name}
              <Text dimColor={i !== clamped}>  {c.desc}</Text>
            </Text>
          ))}
          <Text dimColor>↑↓ 选择 · Tab/回车 补全 · Esc 关闭 · ↑↓(无菜单) 翻历史</Text>
        </Box>
      )}
      <Text dimColor>{separator}</Text>
      <Box>
        <Text dimColor>&gt; </Text>
        <Text>{inputDisplay}</Text>
      </Box>
      <Text dimColor>{separator}</Text>
    </Box>
  );
}

/** kcode 主界面：流式输出、工具状态、菜单式确认（diff 预览）、Todo 面板、结构化提问、四档权限模式 */
export function KcodeApp(props: KcodeAppProps) {
  const { exit } = useApp();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [streamText, setStreamText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busySince, setBusySince] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [ask, setAsk] = useState<AskState | null>(null);
  const [question, setQuestion] = useState<QuestionState | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [mode, setMode] = useState<PermissionMode>("default");
  const [modelLabel, setModelLabel] = useState(props.model);
  const [fullAccessConfirm, setFullAccessConfirm] = useState(false);
  const [input, setInput] = useState("");
  const [spinVerb, setSpinVerb] = useState("思考中");
  const [modelPicker, setModelPicker] = useState<ModelPicker>(null);
  const [loginWizard, setLoginWizard] = useState<LoginWizard>(null);
  const [commands, setCommands] = useState<CommandInfo[]>(BUILTIN_COMMANDS);
  /** IME 上屏强制重绘：终端清除组合区覆盖的时机在应用渲染之后（日志实测 0~1.3s 窗口），
   *  0~1.5s 五连重绘覆盖；交替空格保证每次帧都有 diff 绕过 Ink 去重 */
  const [repaintTick, setRepaintTick] = useState(0);
  const pingRepaint = (): void => {
    setRepaintTick((t) => t + 1);
    // 两拍即可（CJK 扁平渲染修复后提交帧本身正确；多拍反而造成底部闪动）
    setTimeout(() => setRepaintTick((t) => t + 1), 400);
  };
  useEffect(() => {
    if (process.env["KCODE_INPUT_DEBUG"] === "1" && repaintTick > 0) {
      try {
        appendInputLog(`repaint tick=${repaintTick}`);
      } catch {}
    }
  }, [repaintTick]);
  /** 转写展开态（Ctrl+O 切换）：思考全文 / 工具输出多行 */
  const [verbose, setVerbose] = useState(false);
  /** 驱动 running 态动态耗时与 busy 计时的时钟（250ms 一拍） */
  const [tick, setTick] = useState(Date.now());
  const sessionRef = useRef<Awaited<ReturnType<typeof createSession>> | null>(null);
  const streamRef = useRef("");
  const inputHistory = useRef<string[]>([]);
  const reasoningRef = useRef("");
  const reasoningStartedAt = useRef<number | null>(null);
  const interactive = process.stdin.isTTY === true;
  const [reasoningText, setReasoningText] = useState("");

  // 时钟只在有动态内容时运行（busy/运行中工具/流式文本）——
  // 空闲时持续重渲染会在部分终端（conhost/管道输出）造成帧堆积刷屏
  const active =
    busy ||
    reasoningText !== "" ||
    streamText !== "" ||
    blocks.some((b) => b.kind === "tool" && b.status === "running");
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => {
      setTick(Date.now());
      // 思考增量合帧刷显：reasoning delta 量大，逐条 setState 会拖垮 Ink 渲染
      setReasoningText(reasoningRef.current);
    }, 250);
    return () => clearInterval(timer);
  }, [active]);

  // Ctrl+O：折叠 ⇄ 展开转写（对标 Claude Code 的 transcript 切换）
  useInput(
    (ch, key) => {
      if (key.ctrl && ch.toLowerCase() === "o") {
        setVerbose((v) => !v);
      }
    },
    { isActive: interactive },
  );

  /** 本轮已发送过中断（重复按 Esc/Ctrl+C 不再刷提示，等当前命令退出） */
  const abortSent = useRef(false);

  /** 中断当前运行：发送 abort，并立即收掉挂起的交互（daemon 侧也会结算未决 ask） */
  const interruptRun = (): void => {
    if (!busy) {
      return;
    }
    if (abortSent.current) {
      return; // 已请求过：正在等待当前命令被终止
    }
    abortSent.current = true;
    if (ask !== null) {
      ask.resolve({ allowed: false });
      setAsk(null);
      pushBlock({ kind: "info", tone: "deny", text: `❯ 拒绝 · ${ask.call.tool}（随中断）` });
    }
    if (question !== null) {
      question.resolve([]);
      setQuestion(null);
      pushBlock({ kind: "info", text: "→ 已选：（随中断取消）" });
    }
    sessionRef.current?.abort();
    pushBlock({ kind: "info", tone: "warn", text: "⎋ 已请求中断当前运行…" });
  };

  const menuOccupied =
    ask !== null ||
    question !== null ||
    fullAccessConfirm ||
    modelPicker !== null ||
    loginWizard !== null;

  // Esc：busy 时中断（菜单占用时 Esc 归菜单）
  useInput(
    (_ch, key) => {
      if (key.escape) {
        interruptRun();
      }
    },
    { isActive: interactive && busy && !menuOccupied },
  );

  // Ctrl+C：busy 时中断；空闲时双击退出（Ink 的 exitOnCtrlC 已关，退出语义自己管）
  const lastCtrlCAt = useRef(0);
  useInput(
    (ch, key) => {
      if (key.ctrl && ch === "c") {
        if (busy && !menuOccupied) {
          interruptRun();
          return;
        }
        if (!busy) {
          const now = Date.now();
          if (now - lastCtrlCAt.current < 1500) {
            exit();
          } else {
            lastCtrlCAt.current = now;
            pushBlock({ kind: "info", tone: "warn", text: "再按一次 Ctrl+C 退出（运行中按 Ctrl+C 为中断）" });
          }
        }
      }
    },
    { isActive: interactive },
  );

  // daemon 掉线：提示重启与续接（pending 运行由 session 层 reject，busy 随之解除）
  useEffect(() => {
    return props.client.onClose(() => {
      pushBlock({
        kind: "info",
        tone: "warn",
        text: "✗ 与守护进程的连接已断开（daemon 可能已退出）。请 exit 后重新启动；历史可 --resume latest 续接",
      });
    });
  }, []);

  const pushBlock = (block: Block): void => {
    setBlocks((prev) => [...prev, block]);
  };

  const appendDelta = (delta: string): void => {
    streamRef.current += delta;
    setStreamText(streamRef.current);
  };

  const appendReasoning = (delta: string): void => {
    if (reasoningStartedAt.current === null) {
      reasoningStartedAt.current = Date.now();
    }
    reasoningRef.current += delta;
  };

  /** 把流式缓冲定格为完成块（工具调用开始或轮次完成时）；思考折叠为单行摘要 */
  const flushStream = (): void => {
    if (reasoningRef.current !== "") {
      const text = reasoningRef.current;
      const ms =
        reasoningStartedAt.current !== null ? Date.now() - reasoningStartedAt.current : undefined;
      reasoningRef.current = "";
      reasoningStartedAt.current = null;
      setReasoningText("");
      pushBlock({ kind: "reasoning", text, ...(ms !== undefined ? { ms } : {}) });
    }
    if (streamRef.current !== "") {
      const text = streamRef.current;
      streamRef.current = "";
      setStreamText("");
      pushBlock({ kind: "assistant", text });
    }
  };

  /** 手动 /skill 注入：下一轮 user_message 不整段回显（daemon 侧仍落盘） */
  const suppressNextUserBlock = useRef(false);

  const handleEvent = (event: SessionEvent): void => {
    switch (event.type) {
      case "user_message":
        if (suppressNextUserBlock.current) {
          suppressNextUserBlock.current = false;
          break;
        }
        pushBlock({ kind: "user", text: event.content });
        break;
      case "tool_call":
        flushStream();
        pushBlock({
          kind: "tool",
          callId: event.callId,
          tool: event.tool,
          argsPreview: formatToolPreview(event.tool, event.args),
          status: "running",
          startedAt: Date.now(),
        });
        break;
      case "tool_result":
        setBlocks((prev) =>
          prev.map((b) => {
            if (b.kind !== "tool" || b.callId !== event.callId) return b;
            const full = event.output !== "" ? event.output : (event.error ?? "");
            const summary = full.split("\n")[0]?.slice(0, 120) ?? "";
            return {
              ...b,
              status: event.ok ? "done" : "failed",
              summary,
              output: full.slice(0, 2000),
              ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
            };
          }),
        );
        break;
      case "assistant_message":
        if (streamRef.current !== "") {
          flushStream();
        } else {
          pushBlock({ kind: "assistant", text: event.content });
        }
        break;
      case "compaction_summary":
        pushBlock({ kind: "info", text: `⑂ ${event.summary}` });
        break;
      case "run_limit_reached":
        pushBlock({
          kind: "info",
          tone: "warn",
          text: `⏸ 已达单轮步数上限（${event.maxTurns} 步，防失控保护）。上下文已保留，输入「继续」可接着做`,
        });
        break;
      case "llm_error":
        flushStream();
        pushBlock({ kind: "info", tone: "warn", text: `✗ 模型调用失败：${event.error}` });
        break;
      case "todo_update":
        setTodos(event.todos);
        break;
      case "skill_used":
        pushBlock({
          kind: "info",
          text: `📖 技能 ${event.skill} 已加载（${event.trigger === "auto" ? "自动触发" : "手动"}）`,
        });
        break;
      default:
        break;
    }
  };

  /** 应用模式切换：本地状态 + 守护进程侧引擎换档 */
  const applyMode = (next: PermissionMode): void => {
    setMode(next);
    sessionRef.current?.setMode(next);
    pushBlock({ kind: "info", text: `⇄ 已切换：${MODE_META[next].label}（${MODE_META[next].hint}）` });
  };

  const asker: PermissionAsker = {
    confirm: (call) =>
      new Promise<boolean | PermissionAnswer>((resolve) => {
        if (!interactive) {
          // 非交互环境（管道/CI）自动拒绝——automation 同款语义（§5.5）
          setNotice(`非交互环境，已自动拒绝 ${call.tool}`);
          resolve(false);
          return;
        }
        setAsk({ call: call as AskState["call"], resolve });
      }),
  };

  const askUser: UserPromptPort = {
    ask: (q) =>
      new Promise<string[]>((resolve) => {
        if (!interactive) {
          resolve([]);
          return;
        }
        setQuestion({ question: q, resolve });
      }),
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const handle = await createSession({
          client: props.client,
          model: props.model,
          cwd: props.cwd,
          resumeFrom: props.resumeFrom,
          onEvent: (e) => {
            if (!cancelled) handleEvent(e);
          },
          onDelta: (d) => {
            if (!cancelled) appendDelta(d);
          },
          onReasoning: (d) => {
            if (!cancelled) appendReasoning(d);
          },
          onNotice: (n) => {
            if (!cancelled) setNotice(n);
          },
          asker,
          askUser,
        });
        sessionRef.current = handle;
        setReady(true);
        pushBlock({ kind: "banner", model: props.model, cwd: props.cwd });
        // 自定义命令并入补全菜单（预取异步完成晚于就绪时，600ms 后补读一次）
        const mergeCommands = (): void => {
          setCommands([
            ...BUILTIN_COMMANDS,
            ...handle.listCommands().map((c) => ({
              name: c.name,
              desc: c.source === "project" ? "（项目自定义命令）" : "（用户自定义命令）",
            })),
          ]);
        };
        mergeCommands();
        setTimeout(mergeCommands, 600);
        if (props.oneShot !== undefined) {
          setBusy(true);
          setBusySince(Date.now());
          try {
            await handle.loop.run(
              props.oneShot,
              props.images !== undefined ? { images: props.images } : {},
            );
          } finally {
            setBusy(false);
            setBusySince(null);
            setTimeout(() => exit(), 80);
          }
        }
      } catch (err) {
        if (!cancelled) {
          const raw = err instanceof Error ? err.message : String(err);
          // keychain 报错几乎总是「daemon 继承了无口令终端的环境」——给出可操作修复步骤
          const hint = raw.includes("KCODE_KEYCHAIN_PASSPHRASE")
            ? "\n\n修复：在设置了口令的终端里结束旧 daemon 后重启 kcode——\n" +
              "  1) 结束旧 daemon：taskkill /F /PID <pid>（pid 见 ~/.kcode/daemon.pid 文件内容）\n" +
              '  2) 设置口令：PowerShell $env:KCODE_KEYCHAIN_PASSPHRASE="..." ／ cmd set KCODE_KEYCHAIN_PASSPHRASE=...\n' +
              "  3) 重新运行 npx tsx src/main.tsx（daemon 将以新环境自动拉起）"
            : "";
          setFatal(raw + hint);
          setTimeout(() => exit(), 80);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (value: string): Promise<void> => {
    const text = value.trim();
    if (text === "" || busy || sessionRef.current === null) return;
    if (text === "exit" || text === "quit") {
      exit();
      return;
    }
    const session = sessionRef.current;

    if (text.startsWith("/")) {
      const body = text.slice(1);
      const spaceIndex = body.indexOf(" ");
      const name = spaceIndex === -1 ? body : body.slice(0, spaceIndex);
      const args = spaceIndex === -1 ? "" : body.slice(spaceIndex + 1).trim();
      setInput("");

      if (name === "mode") {
        const target = args === "" ? undefined : (args as PermissionMode);
        if (target === undefined) {
          // 循环切换（跳过 fullAccess）
          const index = MODE_CYCLE.indexOf(mode);
          const next = MODE_CYCLE[(index + 1) % MODE_CYCLE.length] ?? "default";
          applyMode(next);
          return;
        }
        if (!(target in MODE_META)) {
          pushBlock({ kind: "info", tone: "warn", text: `未知模式 ${target}：可选 plan / default / acceptEdits / fullAccess` });
          return;
        }
        if (target === "fullAccess" && mode !== "fullAccess") {
          // 全自动放行风险高：显式确认后才生效
          setFullAccessConfirm(true);
          return;
        }
        applyMode(target);
        return;
      }
      if (name === "plan") {
        // 旧命令保留为 plan ↔ default 切换别名
        applyMode(mode === "plan" ? "default" : "plan");
        return;
      }
      if (name === "model") {
        if (args === "") {
          // 选择菜单：默认引用 + 当前会话模型（自定义引用用 /model <provider/模型名>）
          const info = await session.models().catch(() => null);
          if (info === null) {
            pushBlock({ kind: "info", tone: "warn", text: "模型清单获取失败（守护进程连接异常）" });
            return;
          }
          const options: MenuOption[] = [];
          if (info.default !== undefined) {
            options.push({ key: "1", label: `${info.default}（配置默认）` });
          }
          if (modelLabel !== info.default) {
            options.push({ key: "2", label: `${modelLabel}（当前会话）` });
          }
          options.push({ key: "q", label: "取消" });
          setModelPicker({ options });
          return;
        }
        const error = await session.setModel(args);
        if (error !== null) {
          pushBlock({ kind: "info", tone: "warn", text: `✗ 模型切换失败：${error}` });
          return;
        }
        setModelLabel(args);
        pushBlock({ kind: "info", tone: "ok", text: `⭄ 模型已切换：${args}（历史保留）` });
        return;
      }
      if (name === "login") {
        setLoginWizard({ stage: "method", providerName: "", presetBaseURL: "", presetModel: "", baseURL: "", apiKey: "", model: "" });
        return;
      }
      if (name === "skills") {
        const skills = await session.listSkills().catch(() => null);
        pushBlock({
          kind: "info",
          text:
            skills === null || skills.length === 0
              ? "（当前会话未发现技能；可在 .kcode/skills/ 或 ~/.kcode/skills/ 添加）"
              : `已装载技能（${skills.length} 个，/skill <名称> 手动注入）：\n${skills
                  .map((s) => `· ${s.name} — ${s.description}`)
                  .join("\n")}`,
        });
        return;
      }
      if (name === "skill") {
        if (args === "") {
          pushBlock({ kind: "info", tone: "warn", text: "用法：/skill <名称>（/skills 查看清单）" });
          return;
        }
        const body = await session.skillBody(args);
        if (body === null) {
          pushBlock({ kind: "info", tone: "warn", text: `✗ 技能 ${args} 不存在（/skills 查看清单）` });
          return;
        }
        pushBlock({ kind: "info", text: `📖 手动注入技能 ${args}` });
        suppressNextUserBlock.current = true;
        setBusy(true);
        setBusySince(Date.now());
        try {
          await session.loop.run(`<skill name="${args}">
${body}
</skill>`);
        } catch (err) {
          pushBlock({ kind: "info", tone: "warn", text: `✗ ${err instanceof Error ? err.message : String(err)}` });
        } finally {
          setBusy(false);
          setBusySince(null);
        }
        return;
      }
      if (name === "sessions") {
        const sessions = await session.listSessions().catch(() => null);
        pushBlock({
          kind: "info",
          text:
            sessions === null || sessions.length === 0
              ? "（暂无历史会话）"
              : `最近会话（重启后 kcode --resume <id 前缀> 续接）：\n${sessions
                  .map((s) => `· ${s.sessionId.slice(0, 16)}… · ${s.turns} 轮 · ${s.preview || "（空）"}`)
                  .join("\n")}`,
        });
        return;
      }
      if (name === "trust") {
        await session.trustProject();
        pushBlock({ kind: "info", text: "已信任当前项目（项目级 hooks/技能/命令将生效）" });
        return;
      }
      if (name === "help") {
        const customs = session
          .listCommands()
          .map((c) => `/${c.name}${c.source === "project" ? "（项目）" : "（用户）"}`);
        const builtins = [
          "/mode [名称] 切换权限模式（plan/default/acceptEdits/fullAccess）",
          "/model [引用] 查看/切换模型（无参出选择菜单）",
          "/login 配置模型厂商与 API key（向导，自动写配置）",
          "/skills · /skill <名称> 查看/手动注入技能",
          "/sessions 最近会话列表（--resume 续接）",
          "/plan 计划模式快捷切换",
          "/trust 信任当前项目",
          "/help 显示本帮助",
          "exit 退出",
        ];
        pushBlock({
          kind: "info",
          text: `内置命令：\n${builtins.join("\n")}${customs.length > 0 ? `\n自定义命令：\n${customs.join("\n")}` : "\n（暂无自定义命令，可在 .kcode/commands/*.md 添加）"}`,
        });
        return;
      }
      const expanded = await session.expandCommand(name, args);
      if (expanded === null) {
        pushBlock({ kind: "info", text: `未知命令 /${name}（/help 查看可用命令）` });
        return;
      }
      inputHistory.current = [...inputHistory.current, text].slice(-50);
      setBusy(true);
      setBusySince(Date.now());
      try {
        await session.loop.run(expanded);
      } catch (err) {
        pushBlock({ kind: "info", tone: "warn", text: `✗ ${err instanceof Error ? err.message : String(err)}` });
      } finally {
        setBusy(false);
        setBusySince(null);
      }
      return;
    }

    setInput("");
    inputHistory.current = [...inputHistory.current, text].slice(-50);
    abortSent.current = false;
    setSpinVerb(SPIN_VERBS[Math.floor(Math.random() * SPIN_VERBS.length)] ?? "思考中");
    setBusy(true);
    setBusySince(Date.now());
    try {
      await session.loop.run(text);
    } catch (err) {
      pushBlock({ kind: "info", tone: "warn", text: `✗ ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(false);
      setBusySince(null);
    }
  };

  if (fatal !== null) {
    return (
      <Text color="red">✗ {fatal}</Text>
    );
  }

  const meta = MODE_META[mode];
  const busyElapsed =
    busy && busySince !== null && tick > busySince ? ` (${((tick - busySince) / 1000).toFixed(1)}s)` : "";

  // Static 架构：已完成块一次性推进 scrollback（不再重绘，长会话不整帧重印）；
  // 活跃帧只保留尾部——运行中的工具块 + 流式文本 + 交互区。
  const runningTail: Block[] = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === "tool" && b.status === "running") {
      runningTail.unshift(b);
    } else {
      break;
    }
  }
  const finalized = blocks.slice(0, blocks.length - runningTail.length);

  return (
    <Box flexDirection="column" width="100%">
      <Static items={finalized}>
        {(block, index) => <BlockView key={index} block={block} verbose={verbose} />}
      </Static>
      {runningTail.map((b, i) => (
        <BlockView key={`live-${i}`} block={b} verbose={verbose} now={tick} />
      ))}
      {reasoningText !== "" && (
        <Text dimColor italic wrap="truncate-end">
          ✻ {reasoningText.split("\n").at(-1)?.slice(-100) ?? ""}
        </Text>
      )}
      {streamText !== "" && <Text color="white">{streamText}</Text>}
      {todos.length > 0 && <TodoPanel todos={todos} />}
      {notice !== null && (
        <Text color="yellow" wrap="truncate-end">
          {notice}
        </Text>
      )}
      {ask !== null ? (
        <Box flexDirection="column">
          <Text color="magenta">
            ⚠ 允许 {ask.call.tool} {JSON.stringify(ask.call.args).slice(0, 80)} ？
          </Text>
          {ask.call.preview !== undefined && <DiffPreview preview={ask.call.preview} />}
          <OptionsMenu
            options={[
              { key: "y", label: "允许" },
              { key: "a", label: "允许，本会话不再询问" },
              { key: "n", label: "拒绝" },
            ]}
            onPick={(indices) => {
              const picked = indices[0] ?? 2;
              const answer: PermissionAnswer =
                picked === 0
                  ? { allowed: true }
                  : picked === 1
                    ? { allowed: true, scope: "session" }
                    : { allowed: false };
              ask.resolve(answer);
              setAsk(null);
              pushBlock({
                kind: "info",
                tone: answer.allowed ? "ok" : "deny",
                text: `❯ ${picked === 0 ? "允许" : picked === 1 ? "允许（本会话）" : "拒绝"} · ${ask.call.tool}`,
              });
            }}
            onCancel={() => {
              ask.resolve({ allowed: false });
              setAsk(null);
              pushBlock({ kind: "info", tone: "deny", text: `❯ 拒绝 · ${ask.call.tool}` });
            }}
          />
        </Box>
      ) : fullAccessConfirm ? (
        <Box flexDirection="column">
          <Text color="red" bold>
            ⚠ 切换到完全访问？此会话内全部工具（含 bash）自动放行。
          </Text>
          <OptionsMenu
            options={[
              { key: "n", label: "取消" },
              { key: "y", label: "确认切换（全部自动放行）" },
            ]}
            initialIndex={0}
            onPick={(indices) => {
              setFullAccessConfirm(false);
              if ((indices[0] ?? 0) === 1) {
                applyMode("fullAccess");
              } else {
                pushBlock({ kind: "info", text: "❯ 取消 · 未切换完全访问" });
              }
            }}
            onCancel={() => {
              setFullAccessConfirm(false);
              pushBlock({ kind: "info", text: "❯ 取消 · 未切换完全访问" });
            }}
          />
        </Box>
      ) : loginWizard !== null ? (
        <Box flexDirection="column">
          {loginWizard.stage === "method" ? (
            <>
              <Text color="magenta" bold>
                Login · 选择模型厂商（Esc 取消）
              </Text>
              <OptionsMenu
                options={LOGIN_PRESETS.map((p) => ({ key: p.key, label: p.label }))}
                onPick={(indices) => {
                  const preset = LOGIN_PRESETS[indices[0] ?? 0];
                  if (preset === undefined) {
                    setLoginWizard(null);
                    return;
                  }
                  setLoginWizard({
                    stage: "model",
                    providerName: preset.name,
                    presetBaseURL: preset.baseURL,
                    presetModel: preset.model,
                    baseURL: preset.baseURL,
                    apiKey: "",
                    model: preset.model,
                  });
                }}
                onCancel={() => setLoginWizard(null)}
              />
            </>
          ) : loginWizard.stage === "model" ? (
            <>
              <Text color="magenta" bold>
                Login · 2/4 模型名
              </Text>
              <PromptInput
                label="模型名: "
                initialValue={loginWizard.presetModel}
                onDone={(model) => setLoginWizard({ ...loginWizard, stage: "baseURL", model })}
                onCancel={() => setLoginWizard(null)}
              />
            </>
          ) : loginWizard.stage === "baseURL" ? (
            <>
              <Text color="magenta" bold>
                Login · 3/4 API 地址
              </Text>
              <PromptInput
                label="BaseURL: "
                initialValue={loginWizard.presetBaseURL}
                onDone={(baseURL) =>
                  setLoginWizard({ ...loginWizard, stage: "apikey", baseURL: baseURL.trim() })
                }
                onCancel={() => setLoginWizard(null)}
              />
            </>
          ) : loginWizard.stage === "apikey" ? (
            <>
              <Text color="magenta" bold>
                Login · 4/4 API key（输入不回显）
              </Text>
              <HiddenInput
                label="API key: "
                onDone={(apiKey) =>
                  setLoginWizard({ ...loginWizard, stage: "passphrase", apiKey: apiKey.trim() })
                }
                onCancel={() => setLoginWizard(null)}
              />
            </>
          ) : (
            <>
              <Text color="magenta" bold>
                Login · 设置 keychain 口令（不回显；解锁本地 key 存储）
              </Text>
              <HiddenInput
                label="口令: "
                onDone={(pass) => {
                  const w = loginWizard;
                  setLoginWizard(null);
                  void (async () => {
                    try {
                      const keyRef = `keychain://${w.providerName}`;
                      await saveUserModelsConfig({
                        default: `${w.providerName}/${w.model}`,
                        providers: {
                          [w.providerName]: {
                            type: "openai-compatible",
                            baseURL: w.baseURL,
                            keyRef,
                          },
                        },
                      });
                      const kc = new EncryptedFileKeychain(
                        join(kcodeHome(), "keys.json"),
                        pass,
                      );
                      await kc.set(keyRef, w.apiKey, [w.baseURL]);
                      process.env["KCODE_KEYCHAIN_PASSPHRASE"] = pass;
                      killDaemonByPidfile();
                      pushBlock({
                        kind: "info",
                        tone: "ok",
                        text: `✓ 已保存 ${w.providerName} 配置与 key（默认模型 ${w.providerName}/${w.model}）——重启 kcode 后以新配置启动`,
                      });
                    } catch (err) {
                      pushBlock({
                        kind: "info",
                        tone: "warn",
                        text: `✗ 保存失败：${err instanceof Error ? err.message : String(err)}（若提示解密失败，说明已有 keys.json 使用其他口令——删除 %USERPROFILE%\\.kcode\\keys.json 后重试 /login）`,
                      });
                    }
                  })();
                }}
                onCancel={() => setLoginWizard(null)}
              />
            </>
          )}
        </Box>
      ) : modelPicker !== null ? (
        <Box flexDirection="column">
          <Text color="magenta" bold>
            Select model（Enter 切换 · Esc 取消；自定义模型用 /model &lt;provider/模型名&gt;）
          </Text>
          <OptionsMenu
            options={modelPicker.options}
            onPick={(indices) => {
              const picked = modelPicker.options[indices[0] ?? 0];
              setModelPicker(null);
              if (picked === undefined || picked.key === "q") {
                return;
              }
              const ref = picked.label.replace(/（.*$/, "");
              void (async () => {
                const session = sessionRef.current;
                if (session === null) return;
                const error = await session.setModel(ref);
                if (error !== null) {
                  pushBlock({ kind: "info", tone: "warn", text: `✗ 模型切换失败：${error}` });
                  return;
                }
                setModelLabel(ref);
                pushBlock({ kind: "info", tone: "ok", text: `⭄ 模型已切换：${ref}（历史保留）` });
              })();
            }}
            onCancel={() => setModelPicker(null)}
          />
        </Box>
      ) : question !== null ? (
        <Box flexDirection="column">
          <Text color="magenta" bold>
            ? {question.question.question}
          </Text>
          <OptionsMenu
            options={question.question.options.map((o) => ({
              key: String(question.question.options.indexOf(o) + 1),
              label: o.label + (o.description !== undefined ? ` — ${o.description}` : ""),
            }))}
            multi={question.question.multiSelect === true}
            onPick={(indices) => {
              const labels = indices.map((i) => question.question.options[i]?.label ?? "");
              question.resolve(labels);
              setQuestion(null);
              pushBlock({
                kind: "info",
                text: `→ 已选：${labels.length > 0 ? labels.join("、") : "（未选择）"}`,
              });
            }}
            onCancel={() => {
              question.resolve([]);
              setQuestion(null);
              pushBlock({ kind: "info", text: "→ 已选：（未选择）" });
            }}
          />
        </Box>
      ) : ready ? (
        busy ? (
          <Text dimColor>
            ✻ {reasoningText !== "" ? "思考中" : spinVerb}
            {busyElapsed}…（Esc 中断 · Ctrl+O {verbose ? "折叠" : "展开"}）
          </Text>
        ) : interactive ? (
          <InputBox
            value={input}
            onChange={setInput}
            onSubmit={(v) => void submit(v)}
            history={inputHistory.current}
            commands={commands}
            onCjkCommit={pingRepaint}
          />
        ) : (
          <Text dimColor>（非交互模式：仅执行一次性提问后退出）</Text>
        )
      ) : (
        <Text dimColor>初始化会话…</Text>
      )}
      <Text dimColor wrap="truncate-end">
        {"⧉ "}{meta.label}
        {repaintTick % 2 === 1 ? " " : " "}· {modelLabel} · /mode 切换 · Esc/Ctrl+C 中断 · Ctrl+O{" "}
        {verbose ? "折叠" : "展开"}思考 · exit 退出
      </Text>
    </Box>
  );
}

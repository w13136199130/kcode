import type { PermissionMode } from "@kcode/contracts";

/**
 * CLI 参数解析（N3C-1）：纯函数、零 IO——main.tsx 只负责分发与副作用，
 * 解析规则全部收敛于此并直接单测。
 *
 * 行为变更（有意收紧）：历史上未知 --token 会静默拼进位置参数提示词，
 * 现在直接报错并列出合法参数——"拼错 flag 后模型收到半截命令"比当场报错更糟。
 */

/** 子命令种类：首 token 命中即短路，后续 token 原样透传给对应处理函数 */
type SubcommandKind = "key" | "plugin" | "doctor" | "skills" | "commands" | "update" | "mcp" | "init";

const SUBCOMMANDS: readonly SubcommandKind[] = ["key", "plugin", "doctor", "skills", "commands", "update", "mcp", "init"];

const MODES: readonly PermissionMode[] = ["plan", "default", "acceptEdits", "fullAccess"];

type OutputFormat = "text" | "json" | "stream-json";
const OUTPUT_FORMATS: readonly OutputFormat[] = ["text", "json", "stream-json"];

/** 用法错误：main 出口据此走 exit 2，且不打印 stack（2-04） */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** 解析结果（纯数据）：headless/子命令/TUI 三条路径的所有输入都从这里出 */
export interface CliArgs {
  command?: { kind: SubcommandKind; args: string[] };
  /** -h/--help：main 在一切 IO 前打印 usage 并 exit 0 */
  help: boolean;
  /** -p/--prompt 显式提示词（与位置参数提示词互斥） */
  prompt?: string;
  /** 位置参数拼成的提示词（历史形态：kcode 一次性提问） */
  positionalPrompt?: string;
  /** --image / --attach 附件路径（v1 attach=图片，与 image 同管线） */
  images: string[];
  resume?: string;
  mode?: PermissionMode;
  /** --model <provider/model>：单次运行覆盖（N3F-5 第四层，优先级最高；TUI 与 headless 同一生效点） */
  model?: string;
  cwd?: string;
  /** --settings <path>：用户级配置文件覆盖（CI/多 profile） */
  settings?: string;
  json: boolean;
  /** --output-format：text | json（单条 result） | stream-json（事件流 + result） */
  outputFormat?: OutputFormat;
  /** --max-turns：单轮工具循环上限 */
  maxTurns?: number;
  /** --ephemeral：不落 JSONL（临时会话） */
  ephemeral: boolean;
  /** --session-id：显式会话 ID（脚本可复现/幂等） */
  sessionId?: string;
  /** --interactive：即使带 -p 也进 TUI（默认 -p 恒无头） */
  interactive: boolean;
  disallowedTools?: string[];
}

/** 2-08：stdin 管道内容作为上下文；`-` 表示整段输入就是 prompt */
export function mergeStdinPrompt(stdinText: string, prompt: string): string {
  const stdin = stdinText.replace(/\r\n/g, "\n").trim();
  if (prompt === "-") return stdin;
  return stdin === "" ? prompt : `${stdin}\n\n${prompt}`;
}

export function usageText(): string {
  return [
    "用法：kcode [提示词] [选项]",
    "  -h, --help                   显示本帮助并退出",
    "  -p, --prompt <text>          单次提问（与位置参数提示词二选一）",
    "  -c, --continue               续接当前工作区最近会话（= --resume latest）",
    "  -r, --resume <会话id|latest>  续接指定会话",
    "  -i, --image <路径>            附加图片（可多次）",
    "      --attach <路径>           附件（v1 为图片，等价 --image；文档抽取走会话内 extract 工具）",
    "      --mode <档>               初始权限档：plan | default | acceptEdits | fullAccess",
    "      --model <provider/model>  本次运行覆盖默认模型（最高优先级，如 deepseek/deepseek-chat）",
    "      --json                   无 TUI：NDJSON 输出会话事件流（= --output-format stream-json）",
    "      --output-format <fmt>     text | json（单条 result） | stream-json（事件流 + result）",
    "      --max-turns <n>           单轮工具循环上限（默认 24）",
    "      --ephemeral               不落 JSONL（临时会话，CI 不产生垃圾）",
    "      --session-id <id>         显式会话 ID（脚本复现/幂等）",
    "      --interactive            即使带 -p 也进入 TUI（默认 -p 恒无头）",
    "      --cwd <路径>              以指定目录为工作区启动",
    "      --settings <路径>         用户级配置文件覆盖（缺省 ~/.kcode/config.json）",
    "      --disallowed-tools <名单>  本次运行剔除的工具（逗号/空格分隔，可多次出现）",
    "子命令：kcode init · kcode key add|list · kcode plugin install|list|remove|enable|disable · kcode mcp add|list|remove|test · kcode doctor · kcode skills list · kcode commands list",
  ].join("\n");
}

/** 取 flag 的值：缺失即报错（比静默吞掉更早暴露手误） */
function valueOf(argv: readonly string[], index: number, flag: string): string {
  const v = argv[index + 1];
  if (v === undefined || v === "") {
    throw new UsageError(`参数 ${flag} 需要一个值（${flag} <值>）`);
  }
  return v;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { images: [], json: false, help: false, interactive: false, ephemeral: false };
  const words: string[] = [];
  let promptFlag: string | undefined;
  let disallowed: string[] | undefined;
  let onlyPositional = false; // `--` 之后全部视为提示词（提问文本本身含 - 开头词时使用）

  const head = argv[0];
  if (head !== undefined && (SUBCOMMANDS as readonly string[]).includes(head)) {
    return { ...args, command: { kind: head as SubcommandKind, args: argv.slice(1) } };
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (onlyPositional) {
      words.push(arg);
      continue;
    }
    switch (arg) {
      case "--":
        onlyPositional = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-p":
      case "--prompt":
        promptFlag = valueOf(argv, i, arg);
        i += 1;
        break;
      case "-i":
      case "--image":
      case "--attach":
        args.images.push(valueOf(argv, i, arg));
        i += 1;
        break;
      case "-r":
      case "--resume":
        args.resume = valueOf(argv, i, arg);
        i += 1;
        break;
      case "--mode": {
        const v = valueOf(argv, i, arg);
        if (!(MODES as readonly string[]).includes(v)) {
          throw new UsageError(`--mode 的值只能是：${MODES.join(" | ")}（收到 ${v}）`);
        }
        args.mode = v as PermissionMode;
        i += 1;
        break;
      }
      case "--model":
        args.model = valueOf(argv, i, arg);
        i += 1;
        break;
      case "--cwd":
        args.cwd = valueOf(argv, i, arg);
        i += 1;
        break;
      case "--settings":
        args.settings = valueOf(argv, i, arg);
        i += 1;
        break;
      case "--json":
        args.json = true;
        args.outputFormat = "stream-json";
        break;
      case "--output-format": {
        const v = valueOf(argv, i, arg);
        if (!(OUTPUT_FORMATS as readonly string[]).includes(v)) {
          throw new UsageError(`--output-format 的值只能是：${OUTPUT_FORMATS.join(" | ")}（收到 ${v}）`);
        }
        args.outputFormat = v as OutputFormat;
        i += 1;
        break;
      }
      case "--max-turns": {
        const v = valueOf(argv, i, arg);
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) {
          throw new UsageError(`--max-turns 需要正整数（收到 ${v}）`);
        }
        args.maxTurns = n;
        i += 1;
        break;
      }
      case "--ephemeral":
        args.ephemeral = true;
        break;
      case "--session-id":
        args.sessionId = valueOf(argv, i, arg);
        i += 1;
        break;
      case "--interactive":
        args.interactive = true;
        break;
      case "--disallowed-tools":
      case "--disallowedTools": {
        const parts = valueOf(argv, i, arg)
          .split(/[\s,]+/)
          .filter((s) => s !== "");
        if (parts.length > 0) {
          disallowed = [...(disallowed ?? []), ...parts];
        }
        i += 1;
        break;
      }
      case "-c":
      case "--continue":
        args.resume = "latest";
        break;
      default:
        if (arg.startsWith("-")) {
          throw new UsageError(`未知参数：${arg}\n${usageText()}`);
        }
        words.push(arg);
    }
  }

  if (promptFlag !== undefined && words.length > 0) {
    throw new UsageError("-p/--prompt 与位置参数提示词只能提供一处");
  }
  if (promptFlag !== undefined) {
    args.prompt = promptFlag;
  } else if (words.length > 0) {
    args.positionalPrompt = words.join(" ");
  }
  if (disallowed !== undefined) {
    args.disallowedTools = disallowed;
  }
  return args;
}

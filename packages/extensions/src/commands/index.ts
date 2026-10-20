import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCommandFile, type CommandMeta } from "./frontmatter.js";

export { parseCommandFile, type CommandMeta, type ParsedCommandFile } from "./frontmatter.js";

/** 单级命令名规则：小写字母/数字/连字符，2–32 位；命名空间用 `:` 连接 */
const COMMAND_SEGMENT_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const MAX_COMMAND_NAME = 96;

/** 参数占位符：模板中的 $ARGUMENTS 会被替换为命令后的原始输入 */
const ARGUMENTS_PLACEHOLDER = "$ARGUMENTS";
/** `!` 行输出上限（避免把命令输出整段灌进上下文） */
const BASH_OUTPUT_LIMIT = 8_000;

export interface CommandSource {
  /** 命令根目录：其下每个 .md 文件是一条命令 */
  dir: string;
  source: "project" | "user";
}

export interface DiscoveredCommand extends CommandMeta {
  /** 命名空间形态：subdir/commit.md → subdir:commit */
  name: string;
  filePath: string;
  source: CommandSource["source"];
}

export interface CommandBashResult {
  ok: boolean;
  output: string;
  error?: string;
}

/** `!` 行执行器（session 注入 runUserBash；库本身不直接起进程） */
export type CommandBashRunner = (command: string) => Promise<CommandBashResult>;

/**
 * 发现斜杠命令：按 roots 顺序**递归**扫描 .md 文件，同名命令先见者胜——
 * 优先级 project > user（项目可覆盖用户级同名命令）。
 * 3-17：子目录生成命名空间 `ns:cmd`；frontmatter 在此解析，正文在展开时读取。
 */
export async function discoverCommands(
  roots: CommandSource[],
  onWarn?: (message: string) => void,
): Promise<DiscoveredCommand[]> {
  const byName = new Map<string, DiscoveredCommand>();
  for (const root of roots) {
    await walk(root.dir, [], root, byName, onWarn);
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

async function walk(
  dir: string,
  prefix: string[],
  root: CommandSource,
  byName: Map<string, DiscoveredCommand>,
  onWarn?: (message: string) => void,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 目录不存在视为无命令
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    if (entry.isDirectory()) {
      if (!COMMAND_SEGMENT_RE.test(entry.name)) {
        onWarn?.(`命令目录名不合规已忽略：${entry.name}（${root.source}）`);
        continue;
      }
      await walk(join(dir, entry.name), [...prefix, entry.name], root, byName, onWarn);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const segment = entry.name.slice(0, -3);
    if (!COMMAND_SEGMENT_RE.test(segment)) {
      onWarn?.(`命令文件名不合规已忽略：${entry.name}（${root.source}）`);
      continue;
    }
    const name = [...prefix, segment].join(":");
    if (name.length > MAX_COMMAND_NAME) {
      onWarn?.(`命令名过长已忽略：${name}（${root.source}）`);
      continue;
    }
    if (byName.has(name)) {
      continue;
    }
    const filePath = join(dir, entry.name);
    let parsed: ReturnType<typeof parseCommandFile> = { meta: {}, body: "", warnings: [] };
    try {
      parsed = parseCommandFile(await readFile(filePath, "utf8"));
    } catch (err) {
      onWarn?.(`命令读取失败已忽略：${name}（${err instanceof Error ? err.message : String(err)}）`);
      continue;
    }
    for (const warning of parsed.warnings) {
      onWarn?.(`命令 ${name}：${warning}`);
    }
    byName.set(name, { name, filePath, source: root.source, ...parsed.meta });
  }
}

/** 读取命令模板正文（frontmatter 已剥离；展开在调用侧进行） */
export async function readCommandTemplate(filePath: string): Promise<string> {
  return parseCommandFile(await readFile(filePath, "utf8")).body;
}

/** 展开模板：把 $ARGUMENTS 替换为用户输入的参数；无占位符则参数追加在末尾 */
export function expandCommand(template: string, args: string): string {
  if (template.includes(ARGUMENTS_PLACEHOLDER)) {
    return template.split(ARGUMENTS_PLACEHOLDER).join(args);
  }
  return args === "" ? template : `${template}\n\n${args}`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function truncateOutput(text: string): string {
  return text.length <= BASH_OUTPUT_LIMIT
    ? text
    : `${text.slice(0, BASH_OUTPUT_LIMIT)}\n…（输出过长，已截断 ${text.length - BASH_OUTPUT_LIMIT} 字符）`;
}

/**
 * 3-17：展开命令模板并执行 `!` 行（CC 风格 `!`command``，同时接受 `!command`）。
 * - 围栏代码块内的 `!` 行不执行（避免示例命令被误跑）；
 * - 输出以 `<bash_command command="…">` 包裹回填，失败带 ok="false"；
 * - 无执行器时明确标注“未执行”，绝不把 `!` 原样漏给模型。
 */
export async function expandCommandTemplate(
  template: string,
  args: string,
  options: { bash?: CommandBashRunner } = {},
): Promise<string> {
  const expanded = expandCommand(template, args);
  if (!expanded.includes("!")) {
    return expanded;
  }
  const lines = expanded.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    const ticked = /^!`([^`]+)`\s*$/.exec(line);
    // 纯 `!command` 只认 ASCII 命令开头，避免把正文里的“!注意”当命令执行
    const plain = ticked === null ? /^!\s*([A-Za-z0-9_./\\-].*)$/.exec(line) : null;
    const command = (ticked?.[1] ?? plain?.[1] ?? "").trim();
    if (command === "") {
      out.push(line);
      continue;
    }
    if (options.bash === undefined) {
      out.push(`<bash_command command="${escapeAttribute(command)}">（未执行：无 bash 执行器）</bash_command>`);
      continue;
    }
    try {
      const result = await options.bash(command);
      const text = (result.ok ? result.output : (result.error ?? result.output)).trim();
      out.push(
        `<bash_command command="${escapeAttribute(command)}"${result.ok ? "" : ' ok="false"'}>` +
          `\n${truncateOutput(text)}\n</bash_command>`,
      );
    } catch (err) {
      out.push(
        `<bash_command command="${escapeAttribute(command)}" ok="false">\n` +
          `（命令执行失败：${err instanceof Error ? err.message : String(err)}）\n</bash_command>`,
      );
    }
  }
  return out.join("\n");
}

/** 命令库：持有发现结果（含 frontmatter 元数据），支持按名展开 */
export class CommandLibrary {
  readonly #commands: Map<string, DiscoveredCommand>;

  private constructor(commands: DiscoveredCommand[]) {
    this.#commands = new Map(commands.map((c) => [c.name, c]));
  }

  static async open(roots: CommandSource[], onWarn?: (message: string) => void): Promise<CommandLibrary> {
    return new CommandLibrary(await discoverCommands(roots, onWarn));
  }

  list(): DiscoveredCommand[] {
    return [...this.#commands.values()];
  }

  get(name: string): DiscoveredCommand | undefined {
    return this.#commands.get(name);
  }

  /** 展开指定命令（执行 `!` 行）；不存在返回 null */
  async expand(name: string, args: string, bash?: CommandBashRunner): Promise<string | null> {
    const command = this.#commands.get(name);
    if (command === undefined) {
      return null;
    }
    const template = await readCommandTemplate(command.filePath);
    return expandCommandTemplate(template, args, bash !== undefined ? { bash } : {});
  }
}

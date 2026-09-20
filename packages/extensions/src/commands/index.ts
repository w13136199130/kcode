import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** 斜杠命令名规则：小写字母/数字/连字符，2–32 位 */
const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

/** 参数占位符：模板中的 $ARGUMENTS 会被替换为命令后的原始输入 */
const ARGUMENTS_PLACEHOLDER = "$ARGUMENTS";

export interface CommandSource {
  /** 命令根目录：其下每个 .md 文件是一条命令 */
  dir: string;
  source: "project" | "user";
}

export interface DiscoveredCommand {
  name: string;
  filePath: string;
  source: CommandSource["source"];
}

/**
 * 发现斜杠命令：按 roots 顺序扫描 .md 文件，同名命令先见者胜——
 * 优先级 project > user（项目可覆盖用户级同名命令）。
 */
export async function discoverCommands(
  roots: CommandSource[],
  onWarn?: (message: string) => void,
): Promise<DiscoveredCommand[]> {
  const byName = new Map<string, DiscoveredCommand>();
  for (const root of roots) {
    let names: string[];
    try {
      names = await readdir(root.dir);
    } catch {
      continue; // 目录不存在视为无命令
    }
    for (const filename of names) {
      if (!filename.endsWith(".md")) {
        continue;
      }
      const name = filename.slice(0, -3);
      if (!COMMAND_NAME_RE.test(name)) {
        onWarn?.(`命令文件名不合规已忽略：${filename}（${root.source}）`);
        continue;
      }
      if (!byName.has(name)) {
        byName.set(name, { name, filePath: join(root.dir, filename), source: root.source });
      }
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** 读取命令模板正文（原样返回，展开在调用侧进行） */
export async function readCommandTemplate(filePath: string): Promise<string> {
  return (await readFile(filePath, "utf8")).trim();
}

/** 展开模板：把 $ARGUMENTS 替换为用户输入的参数；无占位符则参数追加在末尾 */
export function expandCommand(template: string, args: string): string {
  if (template.includes(ARGUMENTS_PLACEHOLDER)) {
    return template.split(ARGUMENTS_PLACEHOLDER).join(args);
  }
  return args === "" ? template : `${template}\n\n${args}`;
}

/** 命令库：持有发现结果，支持按名展开 */
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

  /** 展开指定命令；不存在返回 null */
  async expand(name: string, args: string): Promise<string | null> {
    const command = this.#commands.get(name);
    if (command === undefined) {
      return null;
    }
    return expandCommand(await readCommandTemplate(command.filePath), args);
  }
}

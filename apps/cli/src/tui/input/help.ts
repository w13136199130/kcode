import { BUILTIN_COMMANDS, type CommandInfo } from "./builtin-commands.js";

/**
 * 2-24：帮助单一事实源。
 * 命令来自 BUILTIN_COMMANDS（与补全菜单同表），自定义命令来自会话；
 * 按键说明只维护这一份，避免 /help 手写清单与实现漂移。
 */
export const KEYBIND_HELP: readonly string[] = [
  "Shift+Tab 循环权限模式（plan/default/acceptEdits）",
  "Esc 中断本轮；空闲双击 Esc 打开回退点菜单",
  "Ctrl+C 中断本轮（审批中 = 拒绝整轮）",
  "Ctrl+T 任务浏览器 · Ctrl+B 工具浏览器 · Ctrl+R 历史搜索",
  "Ctrl+G 外部编辑器 · Ctrl+J 输入换行",
  "Ctrl+A/E 行首/行尾 · Ctrl+U/K 删至行首/行尾 · Ctrl+W 删前一词",
  "Alt/Ctrl+←→ 按词移动 · Ctrl+Z/Y 撤销/重做",
  "/ 命令补全 · @ 文件路径补全",
];

const INPUT_HELP: readonly string[] = [
  "!命令 直接执行 shell（结果只显示，不进模型上下文）",
  "运行中提交的输入自动排队，本轮完成后按序执行；Esc/Ctrl+C 中断会清空排队",
];

function formatCommand(command: CommandInfo): string {
  const alias = command.hidden === true ? "（隐藏别名）" : "";
  const hint = command.argsHint !== undefined && command.argsHint !== "" ? ` ${command.argsHint}` : "";
  return `/${command.name}${alias}${hint} — ${command.desc}`;
}

export function formatHelp(customs: readonly CommandInfo[] = []): string {
  const builtins = BUILTIN_COMMANDS.map(formatCommand);
  const customLines =
    customs.length > 0
      ? customs.map(formatCommand)
      : ["（暂无自定义命令，可在 .kcode/commands/*.md 或 commands/**/sub.md 添加）"];
  return [
    "内置命令：",
    ...builtins,
    "自定义命令：",
    ...customLines,
    "按键：",
    ...KEYBIND_HELP.map((line) => `  ${line}`),
    "输入：",
    ...INPUT_HELP.map((line) => `  ${line}`),
  ].join("\n");
}

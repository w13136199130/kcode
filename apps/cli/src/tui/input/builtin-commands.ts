/** 内置命令清单（/ 自动补全菜单数据源；自定义命令由会话注入合并） */
export interface CommandInfo {
  name: string;
  desc: string;
  /** 参数提示（N3G-1）：命令参数位展示不插入——内置逐个补文案；自定义命令说明 $ARGUMENTS 模板 */
  argsHint?: string;
}

export const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: "mode", desc: "切换权限模式（plan/default/acceptEdits/fullAccess）", argsHint: "[plan | default | acceptEdits | fullAccess]（空 = 循环切换）" },
  { name: "model", desc: "查看/切换模型（选择菜单）", argsHint: "[provider/模型名]（空 = 打开选择菜单）" },
  { name: "login", desc: "配置模型厂商与 API key（向导）", argsHint: "（无参数：启动向导）" },
  { name: "skills", desc: "查看已装载技能", argsHint: "（无参数）" },
  { name: "skill", desc: "手动注入技能正文", argsHint: "<技能名>（/skills 查看清单）" },
  { name: "sessions", desc: "最近会话列表", argsHint: "（无参数）" },
  { name: "resume", desc: "续接历史会话（选择菜单或 latest/id）", argsHint: "[latest | 会话 id 前缀]（空 = 打开菜单）" },
  { name: "rewind", desc: "回退到之前某轮提问（恢复文件+截断对话，双击 Esc 直达）", argsHint: "（无参数：打开回退点菜单）" },
  { name: "compact", desc: "手动压缩历史（保留任务锚点与近期上下文）", argsHint: "（无参数）" },
  { name: "context", desc: "查看上下文 token 占用与压缩阈值", argsHint: "（无参数）" },
  { name: "clear", desc: "清屏并开启全新会话（上下文一并清空）", argsHint: "（无参数）" },
  { name: "status", desc: "会话/模型/模式/用量一览", argsHint: "（无参数）" },
  { name: "mcp", desc: "MCP 服务器接入状态", argsHint: "（无参数）" },
  { name: "permissions", desc: "查看/清除本项目的持久放行", argsHint: "（无参数）" },
  { name: "cost", desc: "查看本会话 token 用量", argsHint: "（无参数）" },
  { name: "plan", desc: "计划模式快捷切换", argsHint: "（无参数：plan ↔ default 切换）" },
  { name: "trust", desc: "信任当前项目", argsHint: "（无参数）" },
  { name: "help", desc: "显示帮助", argsHint: "（无参数）" },
  { name: "exit", desc: "退出", argsHint: "（无参数）" },
];

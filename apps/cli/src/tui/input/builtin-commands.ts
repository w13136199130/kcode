/** 内置命令清单（/ 自动补全菜单数据源；自定义命令由会话注入合并） */
export interface CommandInfo {
  name: string;
  desc: string;
}

/** 内置命令清单（/ 自动补全菜单数据源；自定义命令由会话注入合并） */
export interface CommandInfo {
  name: string;
  desc: string;
}

export const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: "mode", desc: "切换权限模式（plan/default/acceptEdits/fullAccess）" },
  { name: "model", desc: "查看/切换模型（选择菜单）" },
  { name: "login", desc: "配置模型厂商与 API key（向导）" },
  { name: "skills", desc: "查看已装载技能" },
  { name: "skill", desc: "手动注入技能正文" },
  { name: "sessions", desc: "最近会话列表" },
  { name: "resume", desc: "续接历史会话（选择菜单或 latest/id）" },
  { name: "rewind", desc: "回退到之前某轮提问（恢复文件+截断对话，双击 Esc 直达）" },
  { name: "compact", desc: "手动压缩历史（保留任务锚点与近期上下文）" },
  { name: "context", desc: "查看上下文 token 占用与压缩阈值" },
  { name: "clear", desc: "清屏并开启全新会话（上下文一并清空）" },
  { name: "status", desc: "会话/模型/模式/用量一览" },
  { name: "mcp", desc: "MCP 服务器接入状态" },
  { name: "permissions", desc: "查看/清除本项目的持久放行" },
  { name: "cost", desc: "查看本会话 token 用量" },
  { name: "plan", desc: "计划模式快捷切换" },
  { name: "trust", desc: "信任当前项目" },
  { name: "help", desc: "显示帮助" },
  { name: "exit", desc: "退出" },
];

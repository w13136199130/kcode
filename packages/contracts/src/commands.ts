/** 内置斜杠命令元数据（CLI 补全/help 与桌面 Composer 共用） */
export interface CommandInfo {
  name: string;
  desc: string;
  /** 参数提示：命令参数位展示不插入 */
  argsHint?: string;
  /** 隐藏别名：菜单不列，输入完整命令仍识别执行 */
  hidden?: boolean;
}

export const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: "mode", desc: "切换权限模式（plan/default/acceptEdits/fullAccess）", argsHint: "[plan | default | acceptEdits | fullAccess]（空 = 循环切换）" },
  { name: "model", desc: "查看/切换模型（选择菜单）", argsHint: "[provider/模型名]（空 = 打开选择菜单）" },
  { name: "login", desc: "配置模型厂商与 API key（向导）", argsHint: "（无参数：启动向导）" },
  { name: "skills", desc: "查看已装载技能", argsHint: "（无参数）" },
  { name: "skill", desc: "手动注入技能正文", argsHint: "<技能名>（/skills 查看清单）" },
  { name: "sessions", desc: "最近会话列表", argsHint: "（无参数）", hidden: true },
  { name: "rename", desc: "重命名当前会话（写入本地标题）", argsHint: "<标题>" },
  { name: "resume", desc: "续接历史会话（选择菜单或 latest/id）", argsHint: "[latest | 会话 id 前缀]（空 = 打开菜单）" },
  { name: "rewind", desc: "回退到之前某轮提问（恢复文件+截断对话，双击 Esc 直达）", argsHint: "（无参数：打开回退点菜单）" },
  { name: "diff", desc: "审查本会话的文件改动（changed files + hunks），逐文件回退", argsHint: "[文件]（空 = 全部改动）" },
  { name: "compact", desc: "手动压缩历史（保留任务锚点与近期上下文）", argsHint: "（无参数）" },
  { name: "context", desc: "查看上下文 token 占用与压缩阈值", argsHint: "（无参数）" },
  { name: "clear", desc: "清屏并开启全新会话（上下文一并清空）", argsHint: "（无参数）" },
  { name: "status", desc: "会话/模型/模式/用量一览", argsHint: "（无参数）" },
  { name: "mcp", desc: "MCP 服务器接入状态与工具清单", argsHint: "[tools <名称>]（空 = 状态一览）" },
  { name: "hooks", desc: "查看已装载的 hooks 钩子", argsHint: "（无参数）" },
  { name: "tasks", desc: "后台任务清单；停止运行中任务", argsHint: "[stop <id>]（空 = 清单）" },
  { name: "queue", desc: "查看/管理运行中排队的输入", argsHint: "[list | run | clear | rm <序号>]（空 = 清单）" },
  { name: "export", desc: "导出会话为 Markdown 文件", argsHint: "[路径]（空 = ./kcode-session-<id>.md）" },
  { name: "permissions", desc: "查看/清除本项目的持久放行", argsHint: "（无参数）" },
  { name: "cost", desc: "查看本会话 token 用量（缓存/推理/按模型与工具分项）", argsHint: "（无参数）" },
  { name: "usage", desc: "查看本会话 token 用量（/cost 别名）", hidden: true },
  { name: "audit", desc: "查看本会话审计记录（工具/裁决/耗时）", argsHint: "[条数]（默认 20，上限 200）" },
  { name: "copy", desc: "复制最近回复或代码块到剪贴板", argsHint: "[code]（空 = 最近回复）" },
  { name: "plan", desc: "计划模式快捷切换", argsHint: "（无参数：plan ↔ default 切换）", hidden: true },
  { name: "remember", desc: "记住一条项目偏好（写入 AGENTS.md，下次会话生效；同 `# ` 快捷方式）", argsHint: "<内容>" },
  { name: "trust", desc: "信任当前项目", argsHint: "（无参数）" },
  { name: "help", desc: "显示帮助", argsHint: "（无参数）" },
  { name: "exit", desc: "退出", argsHint: "（无参数）" },
];

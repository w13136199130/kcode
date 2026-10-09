# Changelog

## 0.2.0（2026-10-09）

首个正式发行版（0.1.0 为开发期版本号，无对应发布）。相对 0.1.0 的主要变更：

### Agent 引擎
- 上下文压缩对齐：provider usage 校准（真实上下文口径）、绝对预算公式（窗口−输出预留 21k−缓冲 13k）、压缩失败熔断、窗口表未命中透明化
- 子代理消息互通（steer/respond 两态投递）、TurnPhase 显式状态机
- 会话 token 预算护栏（budget.maxSessionTokens / KCODE_BUDGET_TOKENS，到顶问询继续/停止）
- write/edit 原子写（tmp+rename，中断/崩溃不留半截文件）

### 权限与安全
- 持久放行参数级粒度：`bash:npm install:*` 子命令前缀 / edit·write 目录前缀，危险命令只放行整串；审批面板内联展示将保存的规则
- hooks 系统：用户级 ~/.kcode/hooks.json + 项目级（/trust 门控），六事件 + exit 码阻断 + fail-closed 可选，/hooks 可查看

### CLI 体验
- 输入：Tab 三态补全（路径/命令参数/@ 文件）、undo/redo、# 快捷记忆、多行（Ctrl+J/续行）、IME 修复
- 菜单：CC 下拉形态、固定描述列、双层配色、命令面收敛（hidden 别名机制）
- 转写：CC 高还原配色（柔和 hex 状态色）、● 前缀防叠加、Thought for 行、轮尾注脚、放行不回显
- 状态栏：⏵ 模式字形段 + shift+tab 循环切模式 + 上下文中文措辞
- 新命令：/export 会话导出、/hooks、/mcp tools、/model 全量菜单（含窗口注记）
- 终端打磨：OSC8 结构化链接、标题栏进度、完成铃、headless 流式输出、搜索后端可配（KCODE_SEARCH）
- kcode mcp 子命令（add/remove/test）、kcode update 自更新、三层配置覆盖、--model 旗标

### 修复
- /mode 分发键、/exit 斜杠形态两个陈年失效修复 + 内置命令分发链对账护栏
- 双击 Esc 回退、Esc 取消可发现性、login 向导回退/取消

完整设计依据与逐项对标记录见 DESIGN.md §8.4/§11。

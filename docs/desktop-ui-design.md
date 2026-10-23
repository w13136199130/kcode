# kcode 桌面端 UI / 交互设计（原型）

> 状态：**设计原型 v23（无任务列表字段 + 工作区/任务同级树 + 单行任务 + 常规字重 + 整体/单个工作区折叠 + 文件夹加号 + 上下文容量 + Composer 内附件行）**，不进入 `apps/desktop` 产品代码，不改 host 协议。
> v23 参考 ZCode / DeepSeek Harness 桌面版：**工作区/任务同级分组 + 单行任务 + 时间右对齐 + 常规字重 + 工作区整体/单个会话折叠 + 搜索/排序/文件夹加号 + 全局统一字号 + Composer 内横向附件 + 上下文容量/模型/思考**。
> 入口：[docs/desktop-ui-design/index.html](./desktop-ui-design/index.html)
> 截图：[docs/desktop-ui-design/screens](./desktop-ui-design/screens)
> 落地计划与 host 差距：[docs/desktop-ui-implementation-plan.md](./desktop-ui-implementation-plan.md)
> D3-UI 例外：[docs/desktop-ui-exception.md](./desktop-ui-exception.md)

## 1. 设计目标

kcode 桌面端不是“把 TUI 放进窗口”，而是一个**本地编码工作台**：

```text
工作区优先
→ 一条可扫视的会话时间线
→ 工具 / 审批 / diff 在需要时展开
→ 配置和信任边界始终可见
```

参考方向：

- ZCode 的 workspace-first、文件预览 / diff / 插件配置入口；
- DeepSeek Harness 桌面版的“工作目录 + 文件预览 + 变更侧栏 + 插件页面”信息架构；
- 不复制具体视觉，只吸收“桌面工作台”而不是“聊天框”的组织方式。

外部参考：

- <https://github.com/zai-org/ZCode>
- <https://www.ifanr.com/1682532>
- <https://www.tonyreviewsthings.com/zcode-free-ai-coding-ide-glm-5-2/>
- <https://openai.com/codex/>
- <https://github.com/sst/opencode>

## 2. 五条设计原则

1. **工作区是第一上下文**
   - 项目名、路径、分支常驻顶栏；
   - 会话侧栏按项目过滤，不展示 0 轮空会话。

2. **一条 780px 的内容主轴**
   - 对话正文、表格、工具卡、composer 共用同一宽度；
   - 大屏不把输入框拉成通栏。

3. **工具与变更渐进披露**
   - 工具卡默认只显示 `tool + 命令 + 状态 + 耗时`；
   - 展开后看输出；
   - 文件变更进入右侧 context pane，不打断主对话。

4. **审批是明确的决策界面**
   - 四档：本次 / 本会话 / 始终 / 拒绝；
   - 显示风险、修改文件、审计提示；
   - `1–4` 选择，`Enter` 确认，`Esc` 取消。

5. **配置贴着能力走**
   - 模型、provider、key 引用、主题、权限都在设置里；
   - 渲染层只展示 key 引用，不持有明文；
   - 插件 / 自动化 / MCP 有独立入口。

## 2.5 侧栏顶部 / 工作区

侧栏顶部只保留小型产品标识和状态，不再放前进/后退：

```text
[ K ]  kcode   本地
```

- 22px 产品 logo；
- 15px 产品名；
- `本地` 状态徽标；
- 纯展示，不可切换；
- 不占用任务列表空间。

![侧栏顶部](desktop-ui-design/screens/sidebar-top-1440-light.png)

工作区/任务列表：

```text
工作区  ⌄              ⌕  ⇅  📁+
  kcode
    对比 apps 下 5 个应用        2 分钟前
    修复桌面宿主启动              1 小时前
    整理 CLI 优化计划             昨天
  web
  infra
任务  ⌄
  Nginx TCP 转发...             11 天前
  ● 分析降雨量...               36 天前
```

- 不再显示“任务列表”字段，工作区分组直接位于新建会话和一级导航之下；
- “工作区”和“任务”是同级分组，左对齐、同一字号 14px；
- `工作区` 标题右侧是搜索、排序、文件夹加号三个按钮；
- 点击 `工作区` 标题或 `⌄`：整体展开/折叠所有工作区行，但**不自动展开任何工作区会话**；
- 点击某个工作区行：选中并展开它的会话；再点一次折叠它的会话；
- 点击 `任务` 标题或 `⌄`：展开/折叠未归类任务；
- 工作区行只显示文件夹图标、名称；hover/选中时显示 `...`、面板、`+` 操作；
- 任务行单行显示：标题靠左，时间靠右；
- 任务标题 14px、常规字重，选中不加粗；
- 未处理任务可带红色状态点；
- 工作区行 31px，任务行 34px；
- 工作区下任务固定缩进，任务列表不换行；
- 没有归属工作区的任务进入“任务 / 未归类”；
- 工作区标题的文件夹加号添加工作区，打开系统文件夹选择器（原型用 `<input webkitdirectory>`；Electron 落产品时用 `dialog.showOpenDialog`）；
- 选中文件夹后加入工作区，并弹出一次“信任这个工作区？”；
- **新建会话**：
  - 当前选中工作区时，新任务进入该工作区；
  - 点击“任务”标题后，新建任务进入“任务 / 未归类”；
  - 没有任何工作区时，新建任务直接进入“任务”。
- **每个任务**的 `...` 支持：重命名、导出、复制 ID、归档任务、删除任务；
- **每个工作区**的 `...` 支持：新建任务、在编辑器中打开、归档工作区、删除工作区；
- 归档/删除工作区只影响任务组织，不删除本地目录。

![工作区任务树](desktop-ui-design/screens/conversation-1440-light.png)

无工作区时：

![无工作区任务列表](desktop-ui-design/screens/conversation-empty-projects-1440-light.png)

![工作区操作](desktop-ui-design/screens/project-menu-1440-light.png)

![任务操作](desktop-ui-design/screens/task-menu-1440-light.png)

折叠整个工作区列表：

![折叠工作区](desktop-ui-design/screens/project-collapsed-1440-light.png)

- **信任按工作区记录**；信任一次后：
  - 新建任务不再重复询问；
  - 切回该工作区仍保持已信任；
  - 新工作区默认未信任，除非添加时信任。

## 2.6 ZCode 借鉴与取舍

### 值得借鉴

1. **一级导航不是“聊天”一个入口**
   - ZCode 把新建任务、自动化、插件市场放在侧栏顶部；
   - kcode 对应为：对话 / 自动化 / 插件市场。

2. **任务列表按项目分组**
   - 工作区 = 项目，会话 = 任务；
   - 左侧始终能看到“我在哪个项目、跑过哪些任务”。

3. **右侧是进度卡，不是常驻栏**
   - ZCode 的 Agent 进度/子智能体卡片悬浮在右上；
   - kcode 的 context 抽屉改为 400px 浮动面板，高度随内容收缩。

4. **设置是完整工作区，不是小弹窗**
   - ZCode 设置使用左侧分组导航 + 右侧内容；
   - kcode 采用全页设置：230px 导航 + 900px 居中内容。

5. **执行过程可继续/可恢复**
   - 对话里直接展示工具、diff、额度错误、继续按钮；
   - 不需要切到终端看日志。

6. **模型配置是“供应商 → 模型”两层**
   - 供应商预设网格 + provider 详情 + 模型列表；
   - 比单个 Base URL 表单更接近真实使用。

### 不照搬

- ZCode 的浏览器控制、远程设备、电脑控制、插件市场海量条目：kcode 现阶段不展开，保留入口/占位即可。
- ZCode 的高密度小字号：kcode 保持 14px 正文、780px 阅读宽度。
- ZCode 的完整插件生态：kcode 先做本地插件管理，不先做市场。
- 不把设置拆成十几个“必须先配”的页面：模型、外观、权限优先；记忆/MCP/技能/命令等渐进开放。

## 3. 界面结构

```text
┌ titlebar ──────────────────────────────────────────────┐
│ ● ● ●  kcode / 桌面工作台                   本地  ⌘K  │
├ sidebar ──────┬ main (780 居中) ────────┬ context 抽屉 ┤
│ 品牌 / 新会话 │ 项目 · 分支 · 变更/任务  │ 变更 / 任务 │
│ 产品标识      │ 任务时间线              │ 文件列表     │
│ 新建会话      │ 信任 banner             │ diff 预览    │
│ 工作区/任务   │ composer 780px          │ 打开编辑器    │
└───────────────┴─────────────────────────┴──────────────┘
```

### 三种宽度

| 宽度 | 行为 |
|---|---|
| ≥ 1360 | 侧栏 + 780px 主栏 + 右侧浮动 context 抽屉（400px，12px 内缩） |
| 1180–1359 | 主栏保持 780px，context 抽屉同样覆盖打开 |
| < 1180 | 侧栏收窄到 225px，卡片单列；< 860 隐藏侧栏 |

## 4. 关键页面

### 4.1 对话 + 工具 + 变更

![对话](desktop-ui-design/screens/conversation-1440-light.png)

- 用户消息右对齐，助手正文左对齐，行高 1.72；
- 工具卡折叠态只保留一行；
- 变更卡显示 `+42 −8`，点击打开右侧 context pane；
- 表格使用轻量网格，不抢正文。

### 4.1b 变更抽屉

![变更抽屉](desktop-ui-design/screens/context-1440-light.png)

- context pane 默认收起，作为 400px 浮动抽屉打开（四周 12px 内缩、圆角 + 阴影）；
- 不挤压主对话，关闭后回到完整 780px 阅读宽度；
- 文件列表 + diff + 在编辑器中打开。

### 4.2 空态

![空态](desktop-ui-design/screens/empty-1440-light.png)

- 顶部信任 banner，不把警告塞进时间线；
- 标题“今天想做什么？” + 三张示例任务卡；
- composer 固定在底部，和正文同宽。

### 4.3 审批

![审批](desktop-ui-design/screens/approval-1440-light.png)

- 命令、风险、修改文件先于选项；
- 四档选项使用 2×2 网格；
- 底部明确“写入审计日志”。

### 4.4 设置 / 模型配置

![设置](desktop-ui-design/screens/settings-1440-light.png)

- 全页设置（不是小弹窗）：左侧 230px 导航，右侧 900px 内容列居中；
- 左导航分组：基础设置（常规/模型/外观/权限/浏览器/快捷键）、Agent 能力（记忆/子智能体/插件/MCP/技能/命令/钩子）、数据与统计（使用统计/归档）、关于；
- 顶部“返回工作区”；
- provider 列表 + “添加供应商”预设网格 + 连接配置；
- 添加供应商在设置页内完成：点击右上“添加供应商” → 右侧切换为预设网格 → 选择后回到供应商详情；
- 供应商详情包含套餐/额度卡、Base URL、API 格式、API key、模型列表、启用开关和“添加模型”；
- 添加供应商使用 2 列预设（Z.ai / BigModel / DeepSeek / OpenAI / Anthropic / Kimi / MiniMax / 自定义）；
- API key 只显示 masked reference；
- 主题、密度、字号在“外观”；
- 使用统计有 Token 汇总、柱状趋势、模型占比；

![供应商详情](desktop-ui-design/screens/provider-detail-kimi-1440-light.png)

![添加供应商](desktop-ui-design/screens/provider-picker-1440-light.png)

### 4.5 命令面板

![命令面板](desktop-ui-design/screens/palette-1440-light.png)

- `⌘K` 打开；
- 快速操作 / 会话 / 模型分组；
- 键盘上下选择，Enter 执行。

### 4.6 暗色

![暗色](desktop-ui-design/screens/conversation-1440-dark.png)

暗色不是简单反相：

- 背景 `#0e0e0d`，面板 `#141413`，卡片 `#1b1b19`；
- 主操作仍用低饱和蓝色 `#93a8ff`；
- 橙色只留给信任 / 风险，不扩散。

### 4.7 计划 / 提问

![计划](desktop-ui-design/screens/plan-1440-light.png)

- 计划步骤展示完成/进行中/待执行；
- 批准 / 调整 / 放弃三档；
- 提问弹层支持多选项，Enter 确认。

### 4.8 Onboarding

![引导](desktop-ui-design/screens/onboarding-1440-light.png)

- 项目目录 + 厂商预设 + provider/model/baseURL/key；
- “稍后配置”与“保存并开始”都有明确出口；
- key 只写入本机钥匙串。

### 4.9 自动化 / 插件市场

![自动化](desktop-ui-design/screens/automation-1440-light.png)

- 一级导航：对话 / 自动化 / 插件市场；
- 自动化页：还没有定时任务 + 新建/临时任务 + 模板卡片；
- 插件市场：公开/社区/个人 + 搜索 + 分类列表 + 安装/已安装。

![插件市场](desktop-ui-design/screens/plugins-1440-light.png)

### 4.10 对话运行态

- 额度错误显示为内联 banner，带“重置额度 / 反馈”；
- “继续”按钮在暂停点出现；
- 右侧进度卡显示 `2 / 5`、步骤和子智能体，而不是整列抽屉占满。

### 4.11 子智能体 / MCP / 命令 / 钩子

- 子智能体：列表 → 新建子智能体 → 名称/颜色/模型/描述/工具/系统提示词/注入 AGENTS.md → 保存返回；
- MCP：列表 → 新建 MCP 服务器（名称/类型/超时/协议/命令/参数/环境变量）→ 保存返回；
- MCP 导入：从外部 Agent（Codex CLI）发现 MCP，勾选后导入；
- 命令：列表 → 新建命令（名称/描述/参数/提示词）；
- 钩子：列表 → 新建钩子（事件/运行方式/匹配器/命令/参数）；
- 技能：新建技能直接进入会话，调用 `skill-creator`；插件：添加插件直接进入会话，调用 `plugin-creator`。

![新建子智能体](desktop-ui-design/screens/subagent-form-1440-light.png)

![新建 MCP 服务器](desktop-ui-design/screens/mcp-form-1440-light.png)

![导入 MCP](desktop-ui-design/screens/mcp-import-1440-light.png)

![新建命令](desktop-ui-design/screens/command-form-1440-light.png)

![新建钩子](desktop-ui-design/screens/hook-form-1440-light.png)

### 4.12 终端 / 面板 / 帮助

- 标题栏右侧：切换面板、切换终端、帮助；
- 终端从底部展开，占主区下半部分，composer 暂时收起；
- 面板切换打开右侧“新标签页”：文件 / 浏览器 / 终端 / 审查；
- 帮助菜单：产品文档、用户社群、问题上报、提交漏洞、导出日志、资源管理器、检查更新、关于。

![底部终端](desktop-ui-design/screens/terminal-1440-light.png)

![面板切换](desktop-ui-design/screens/panel-picker-1440-light.png)

![帮助菜单](desktop-ui-design/screens/help-menu-1440-light.png)

### 4.13 Composer：上下文容量 / 模型 / 思考

Composer 工具栏按“左权限、右容量与模型”组织：

```text
[+]  [变更确认]                     [上下文 67%]  [GLM-5.3  高]  [发送]
```

- `+` 是添加附件；不再显示单独的“命令”按钮；
- 权限模式（只读 / 变更确认 / 自动编辑 / 完全访问）紧挨 `+`；
- 右侧上下文环形入口显示当前占比，点击展开：
  - 已用 / 总容量；
  - 平均缓存命中率；
  - 5 小时、每周、MCP 剩余额度；
  - 重置额度入口。
- 模型按钮显示 `模型 + 思考强度`，点击打开模型/思考面板：
  - BigModel / 个人；
  - GLM-5.3、GLM-5.3-Flash（视觉）；
  - 思考强度 低 / 中 / 高，`Ctrl+T` 循环切换。

![模型与思考](desktop-ui-design/screens/model-popover-1440-light.png)

![上下文容量](desktop-ui-design/screens/context-popover-1440-light.png)

附件在 Composer 内部、输入框上方：

- 横向单行排列，不换行；
- 多个附件保持同一基线；
- 超出宽度时横向滚动，不把输入框撑高；
- chip 内包含附件图标、文件名、移除按钮。

![Composer 内横向附件](desktop-ui-design/screens/composer-attachments-1440-light.png)

全局排版统一为：

```text
UI 默认 14px
任务标题 14px
次级 12.5px
元信息 11px
对话正文 14.5px
```

## 5. 交互规格

| 区域 | 交互 |
|---|---|
| 全局 | `⌘/Ctrl+K` 命令；`⌘/Ctrl+B` 侧栏；`⌘/Ctrl+N` 新会话；`⌘/Ctrl+T` 思考强度；`⌘/,` 设置；`Esc` 关闭浮层 |
| Composer | `+` 附件；权限模式；上下文容量；模型/思考；`Enter` 发送；`Shift+Enter` 换行；运行中提交进入队列 |
| 时间线 | 流式输出时自动跟随；用户上滚后暂停跟随，显示“回到底部” |
| 工具卡 | 点击标题展开/折叠输出；失败工具默认显示末尾错误 |
| 变更卡 | 点击打开 context pane；文件列表选择文件；diff 预览 |
| 审批 | `1–4` 选择；`Enter` 确认；`Esc` 取消；显示命令、风险、文件、规则入口 |
| 侧栏 | 一级导航；“任务列表”字段标题；工作区/任务同级分组；工作区标题搜索/排序/文件夹加号；整体展开/折叠工作区行；单个工作区展开/折叠会话；任务标题展开/折叠未归类任务；工作区/任务菜单归档删除；无工作区时新建任务进入“任务” |
| 设置 | 全页分组导航；模型/外观/权限/浏览器/快捷键/记忆/子智能体/MCP/技能/命令/钩子/使用统计/归档；provider 可添加；子智能体/MCP/命令/钩子可新建 |
| 自动化 | 新建定时任务、创建临时任务、模板卡片 |
| 插件市场 | 公开/社区/个人、搜索、安装/已安装、插件管理；添加插件进入会话 |
| 技能 / 插件创建 | 新建技能进入会话调用 `skill-creator`；添加插件进入会话调用 `plugin-creator` |
| 终端 / 面板 | 标题栏切换底部终端；右侧“新标签页”打开文件/浏览器/终端/审查 |
| 帮助 | 标题栏 `?`：文档/社群/上报/漏洞/日志/资源管理器/更新/关于 |
| 空态 | 示例任务卡填入 composer；信任 banner 可操作/关闭 |

### 队列与运行中

原型里保留 composer 底部的 `变更确认 / 模型` 选择器；实际实现时：

- 运行中发送 → host `RuntimeCommandQueue`；
- 队列项在 composer 上方显示 `⧗ 排队 N 条`；
- 附件跟随队列项；
- `Esc` 中断时保留队列，`/queue run` 恢复。

### 已覆盖的可见按钮

- 侧栏：新建、折叠、项目分组/折叠、添加项目、任务打开、任务/项目菜单、归档/删除；
- 任务列表：有项目时新任务进项目；切到“任务/未归类”后新任务进未归类；没有项目时新任务进未归类；
- 顶栏：工作区、变更、任务、命令面板、更多菜单；
- Composer：`+` 附件、权限模式、上下文容量、模型、思考强度、发送、停止、清空队列；
- 会话：工具卡展开、复制、重试、变更卡、文件选择、打开编辑器、信任/关闭信任；
- 审批 / 计划 / 提问：四档审批、计划批准/调整/放弃、问题选项确认；
- 自动化：定时任务、临时任务、模板；
- 插件市场：来源 tab、安装、插件管理；
- 设置：全部分组页面、Provider 预设/添加/编辑、测试连接、保存、更换 key、主题/密度/字号、信任、插件、快捷键、使用统计、归档；
- 设置子页：新建子智能体、MCP（新建/导入）、技能（新建/导入）、命令、钩子；
- 工具面板：切换终端、关闭终端、新建终端标签；右侧面板打开文件/浏览器/终端/审查；
- 帮助：文档/社群/问题上报/漏洞/导出日志/资源管理器/检查更新/关于；
- 会话运行态：额度 banner、重置额度、反馈、继续、进度卡；
- Onboarding：目录选择、厂商预设、保存、稍后配置；
- 通用：工作区/重命名/删除/规则/插件等对话框，命令面板过滤与键盘选择；
- 原型工具条：屏幕切换、主题、展示模式。

## 6. 设计令牌

实现时应落在 `packages/design`，不要复制进 `apps/desktop/styles.css`。

### Light

| token | value |
|---|---|
| `--bg` | `#ffffff` |
| `--panel` | `#fafafa` |
| `--panel-2` | `#f3f3f3` |
| `--ink` | `#111111` |
| `--accent` | `#2563eb` |
| `--green` | `#1f7a52` |
| `--orange` | `#9a5b18` |
| `--red` | `#b43b35` |
| `--content` | `780px` |

### Dark

| token | value |
|---|---|
| `--bg` | `#0e0e0d` |
| `--panel` | `#141413` |
| `--panel-2` | `#1b1b19` |
| `--ink` | `#f0f0ec` |
| `--accent` | `#93a8ff` |
| `--green` | `#73d6a0` |
| `--orange` | `#e7a461` |
| `--red` | `#ff8b82` |

## 7. 与当前实现的映射

| 原型区域 | 现有代码 | 需要的改动 |
|---|---|---|
| 空态 | `apps/desktop/src/renderer/components/Timeline.tsx`、`main.tsx` | 信任 notice 移出时间线；空态判断忽略 notice |
| composer 宽度 | `styles.css` `.composer` | 与 `.timeline` 共用 `--content` |
| 侧栏空会话 | `SessionSidebar.tsx` + host `sessions/list` | 过滤 `turns === 0` |
| header | `WorkspaceHeader.tsx` | 模型/模式降为状态；变更/任务/打开文件夹分级 |
| 设置 | `SettingsOverlay.tsx` | 左导航 + 模型 provider 配置 |
| context pane | `SidePane.tsx` / `ChangesPanel.tsx` | 文件列表 + diff + 打开编辑器 |
| 设计令牌 | `styles.css` + `@kcode/design` | 单一来源，删掉重复 `--z-*` |

## 8. 原型不包含

- 真实 host 连接 / 真实模型调用；
- 流式 token 渲染；
- 实际文件读写 / diff 计算；
- 插件安装；
- Windows 安装包。

这些留给实现阶段，原型只锁定**信息架构、视觉层级和交互契约**。

## 9. 打开方式

直接打开 `docs/desktop-ui-design/index.html`，或：

```powershell
start docs/desktop-ui-design/index.html
```

底部 `PROTOTYPE` 工具条切换：

```text
对话 / 空态 / 变更 / 审批 / 计划 / 提问 / 设置 / 命令 / 引导
```

快捷键：

- `⌘/Ctrl+K`：命令面板
- `⌘/Ctrl+B`：侧栏
- `P`：隐藏/显示原型工具条
- `Esc`：关闭浮层

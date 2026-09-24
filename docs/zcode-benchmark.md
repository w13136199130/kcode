# ZCode 深度对标与 kcode 落地设计

> 本文是 [DESIGN.md](../DESIGN.md) 的补充细则：**ZCode 全量功能模块 + 实现思路的逐项剖析**，以及
> **kcode 如何对标（或超越）它的分步执行设计**。DESIGN.md 管"方向与优先级"，本文管"每一项怎么做、抄什么、改什么"。
>
> 数据来源：`E:\space\my_space\MyProject\zcode`（zai-org/ZCode 本地克隆，提交 `29628c9`，2026-09-24）。
> 引用形式 `file:line` 均指向该仓库。**只读参考其设计取舍，不复制代码。**

---

## 0. 结论速览

ZCode 不是"一个 CLI"，而是**一套跨端 Agent 平台**：核心 Agent 引擎 + 一套版本化协议 + 自定义 RPC，被 CLI(TUI)/桌面(Electron)/Web 三端 + 远程(SSH/WSL/Docker)共用。它的强项在**协议工程、可执行架构治理、设计令牌系统、插件市场生命周期**；它的"累赘"在**双协议并存、自研二进制 RPC、为多客户端过度设计的 CommandInbox 幂等网关、大量占位包**。

kcode 的对标策略分三类：

1. **照抄其设计（低风险高收益）**：协议契约与能力协商、事件游标与快照/增量、工具 `ToolEntry` 契约、上下文微压缩与锚点、`OutputCollector` 三段预算、`pwd -P` cwd 持久、配置多级深合并、`architecture-policy.yaml` 基线门禁、`text-ui-*` 设计令牌、`createServiceLogger`。
2. **简化其实现（它做复杂了）**：单套协议（不做双轨）、stdio JSON-Line（不自研二进制 RPC）、`RuntimeCommandQueue`（不做 500 行幂等网关）、子代理最小集（不做 profile 系统）、Ink（不自研 OpenTUI）、`managedOnly` 全模块化（不学它只强制 storage 一个模块）。
3. **不做（占位/与目标无关）**：formal-proof、zcode-cua、swift-bridge、superpowers、postject、动态工作流整套（后置评估）。

---

## 1. ZCode 全量功能模块剖析

### 1.1 协议层（packages/shared）

ZCode 有**两套并存协议**（历史包袱）：旧 `zcode-protocol/index.ts`（JSON-RPC 风格，约 3700 行）与 `zcode-protocol-v4/`（topic/增量式 wire）。kcode 只对标 v4 的精华。

| 能力 | ZCode 实现 | kcode 决策 |
|---|---|---|
| 信封 | `Request/Notification/Response/Error` 四型，`id/method/params/trace` | 采纳（contracts 单文件） |
| 版本 | `ZCODE_PROTOCOL_NAME`+`VERSION`，`z.literal()` 强校验；握手 `clientHello` 携 `protocolVersion`+`capabilities` | 采纳：主/次版本 + 双向能力协商 |
| 事件游标 | `logEpoch + seq + revision` 三水位；`subscribe` 带 `base{logEpoch,seq}`，`subscribeAck.mode = snapshot\|resume` | 采纳：快照/增量分离，断线按游标续传 |
| 幂等命令 | `commandId`(uuid v7 重试不变) + `commandKey{sessionId,commandId}` + 回放缓存；ACK 含 `stale/duplicate/noop` | 采纳：命令信封带 commandId |
| stale 防护 | CAS `baseRevision` + `baseLogEpoch`，不匹配返 `staleRevision/staleLogEpoch` | 采纳：多端时必需 |
| 限额 | `PROTOCOL_V4_LIMITS` 集中常量表（帧/分片/缓冲上限）；display 载荷 schema 层 max 限长 | 采纳 |

### 1.2 RPC（packages/rpc）

自研**二进制 RPC**（非 JSON-RPC）：1 字节类型标签 + VQL 变长整数序列化、13 字节帧头、`ChunkStream` 处理粘包半包、`ChannelClient/Server` 二分 call/listen、`ProxyChannel.fromService/toService` 类型安全、`PersistentProtocol` ACK/心跳/断线重放。

**kcode 决策**：N3 启用 host 子进程时用 **stdio + JSON-Line 帧 + zod**（ZCode 桌面实际也是 `zcodeStdioTransport` JSON-Line，stdout 只跑 RPC、stderr 分开），**不自研二进制 RPC**——那是它多端高频场景的优化，kcode 单进程/少量前端用不上。

### 1.3 Agent 引擎（apps/zcode-cli/packages/core）

- **循环**：单 turn 状态机 `TurnPhase` 十态（Idle→ProcessingInput→AwaitingModelResponse→Streaming→SchedulingTools→ExecutingTools/AwaitingPermission→AggregatingResults→Completing/Error）+ `canTransitionTo` 合法迁移表。外层 `RuntimeCommandQueue`（priority now/next/later）串行 drain 多条命令；`admitPrompt` 建立 reservation、判 busy、可 steer 则注入否则排队。
- **工具管线（顺序定死）**：`registry 查找 → 输入校验 → resolveInput 归一化 → PreToolUse hook → 权限 → ToolCallStarted → handler(带 deadline) → 序列化 → PostToolUse hook → 结果`；失败走 `PostToolUseFailure` hook。
- **权限**：hook 链与用户 broker **并发竞速**，decision 可为 allow/deny/escalate/modify。
- **审计**：无独立审计工具，靠 OpenTelemetry trace span + SessionEvent 落地。

**工具全集**（`tool/handlers/index.ts`）：

| 类 | 工具 |
|---|---|
| 文件 | Read / Write / Edit |
| 搜索 | Glob / Grep（embedded search 时隐藏、退化为 Bash find/grep） |
| 执行 | Bash |
| Web | WebFetch / WebSearch |
| 计划/任务 | EnterPlanMode / ExitPlanMode、TodoRead / TodoWrite、AskUserQuestion |
| 子代理 | Agent / Task、SendMessage / RespondToCoordinator、submit_result、escalate |
| 后台 | TaskOutput / TaskStop |
| 记忆 | ReadSessionContext（回读历史会话） |
| 自动化 | CronCreate/List/Update/Delete、OffPeakCreate/List |
| 技能 | Skill |
| REPL | js（node_repl，默认关） |
| 工作流 | CreateWorkflow/AmendWorkflow/SaveWorkflow/EvalWorkflowSnippet/ListWorkflowRuns/GetWorkflowRun/ResumeWorkflowRun/ResolveWorkflowQuestion/ListSavedWorkflows/ListModels |

工具统一 `ToolEntry` 契约（输入/输出 schema、permission、resultBudget、timeout、executionMode），注册表支持 alias 与去重；MCP 工具 `mcp__server__tool` 动态注册。

**kcode 差距**：kcode 已有 Read/Glob/Grep/Write/Edit/Bash/Task/Todo/ask_user/sessions/web(extract)；**缺**：ReadSessionContext、SendMessage/RespondToCoordinator（子代理消息互通）、TaskOutput/TaskStop（后台任务显式控制）、CronCreate/OffPeakCreate（调度）、EnterPlanMode/ExitPlanMode 的命名对齐、Skill 显式工具。

### 1.4 上下文与压缩

- 阈值：contextWindow 200k，扣 output reserve 32k + buffer 13k；token 来源 estimate 或 provider_usage 覆盖；连续 3 次失败熔断。
- **微压缩**：token 压力或闲置>60min 触发，仅清可压缩工具（Read/Bash/Grep…）的旧结果、保留最近 5 组，节省 <256 token 则不执行。
- **手动/自动**：按 assistant 轮分组（`rounds.ts`），保留最近 1 组作**锚点段** `anchorMessageId=summaryMessageId`；system/`<system-reminder>` 前缀消息不进压缩。

**kcode 决策**：kcode 的三层压缩已接近；N0 要补的是"按完整轮分组 + 锚点段"（替代固定 10 条切片），这正是 ZCode 的做法。

### 1.5 子代理

内置 `general-purpose`/`explore` + 351 行 profile 系统（工具允许表、模型选择、权限模式、system prompt）。独立 child session + 独立 system prompt，仅透传 description/允许工具；结果经 runtime command queue 的 `task-notification`/`subagent-message` 回传；工具执行 `maxConcurrency` 默认 10。

**kcode 决策**：保留 general-purpose/explore + 白名单 + 结果回传最小集，**不做 profile 系统**；但**采纳"子代理消息互通"（SendMessage/RespondToCoordinator）**，这是 kcode 目前缺的。

### 1.6 输入准入 CommandInbox / owner-lease

三层事实分离：in-flight/live-input 恒 pin，settled 进 512/session LRU；同 commandId 重复返 `duplicate`；固定锁序 key gate→session gate；CAS 双校验；`residencyFinalizationCount` 引用计数 + `ActiveTurnStartReservation` 防双 turn。

**kcode 决策**：这是为多客户端 Web 设计的（500+ 行）。kcode 单进程 CLI 只需 `RuntimeCommandQueue`（优先队列）+ 单 reservation；owner/lease 到 N2 多端时再按需引入，**不照抄全套**。

### 1.7 TUI 与交互（OpenTUI，非 Ink）

React + **OpenTUI**（`@mbears/opentui-core`）自研渲染器。`app.tsx` 聚合约 20 个控制器 hooks；`app-view.tsx` 分 `AppShell→ContentPane(正文)+ComposerInputArea(输入/建议/队列面板)`。

- **输出分层**：正文分块 parts = `tool`/`thought`/文本；tool 渲染卡片、thought 半透明；压缩显示为 timeline 行。
- **主题**：`TuiThemeTokens`（primary/secondary/diff/markdown/syntax 全套），映射终端色；明暗靠 terminal palette 亮度自动探测。
- **输入**：textarea，return 提交、shift+return 换行、2–6 行自适应、word wrap；粘贴图片独立 clipboard hook。

**kcode 决策**：**保留 Ink**（不自研 OpenTUI，成本不对等）。但要采纳其**输出分层与令牌映射思路**：正文/工作状态/执行记录/思考摘要四层 + `TuiThemeTokens` 语义令牌映射 ANSI（这正是 kcode N1-5 设计令牌要补的）。交互上对齐 shift+return 换行、2-6 行自适应、事件驱动状态（替代随机 spinner 动词）。

### 1.8 adapters（apps/zcode-cli/packages/adapters）

- **exec**：`OutputCollector` 三段预算——inline 直接回传、超限转写盘 artifact(on_truncate)、保留尾部 tail；cwd 持久靠命令包裹 `pwd -P` 回写；启动脚本物化 `.sh` 并 `source` 前置。
- **config**：五级合并 System→User(~/.zcode)→Project(root→cwd)→Env(ZCODE_*)→CLI；深合并 nested（modelStream/permission/mcp.servers/plugins/hooks）；MCP 特例 user 覆盖 project。
- **auth**：OAuth/API key/浏览器回调；凭证 AES-256-GCM `enc:v1:` 前缀，密钥来自 `ZCODE_CREDENTIAL_SECRET` 或机器指纹回退。
- **context**：git snapshot 只读 git 命令（branch/status/log），限 2k 字符、3s 超时。
- **device**：跨平台进程树采样，1s 超时、连续 3 次失败停用。

**kcode 决策**：**采纳 OutputCollector 三段预算 + `pwd -P` cwd 持久**（Bash 长输出与 cwd 是最常见痛点）；**采纳五级配置合并 + 深合并 + MCP 特例**；git snapshot 可作 `<env>` 注入的增强（kcode 已注入 OS/shell/cwd，可加 git 分支）。凭证加密 kcode 的 DPAPI 方案已更强，不降级。

### 1.9 业务服务与存储（packages/services）

- **session**：`IZCodeSessionService` 接口经 `createServiceDescriptor` 注册为 RPC 通道；运行态来自 Agent 快照；持久化由后台 sqlite `taskIndexRepo` 承担，shadow 订阅收敛；deferred draft（未发首条消息的空会话）不进 sqlite。
- **storage**：唯一 `managed:true` 模块，`domain→app→adapters` 三层 + 端口注入；`contract.ts` 唯一公开入口；domain 纯函数无 IO、app 只编排、adapters 实现端口。

**kcode 决策**：kcode 单进程用 JSONL 即可，**暂不引入 sqlite**（有索引/并发/调度需求时再评估）。**但采纳 storage 的 domain→app→adapters 分层思想**，用于 kcode 的 `packages/runtime`（session/scheduler）——这是"模块契约"的样板。

### 1.10 共享 UI + 设计系统（packages/ui + DESIGN.md）

- 组件：shadcn/radix 风格、`ai-elements`、`ToolCallBlocks`、`LexicalChatInput`、`GitPane`。
- 服务访问：`useServices.tsx` React Context 注入 `IServiceAccessor`；状态 Zustand 单例 store + slice 拆分。
- **设计令牌**：`--text-ui-xl..2xs` 排印尺度（xl 18/lg 16/base 14/caption 13/sm 12/xs 10/2xs 9）；禁 Tailwind 内置字号与任意 `text-[13px]`；只改 `--ui-font-size` 单点缩放。语义色 `--color-*`。
- **主题**：`light|dark|zai-light|zai-dark|system`，`.dark/.theme-zai-*` class 切换，四套变量块。
- **i18n**：en-US/zh-CN 两 locale，`formatMessage` 占位符。

**kcode 决策**：N1-5 建立 `packages/design/tokens`，**采纳 text-ui-* 尺度 + 语义色 + 单点缩放**，终端侧映射 ANSI；主题先做 System/Light/Dark 三态（不做 Zai 变体）。i18n 列为 N4-7（先中文）。

### 1.11 桌面 / Web / 服务端

- **桌面**：每窗口 `utilityProcess.fork` 一个 Host，`MessageChannelMain` 传 port；stdio JSON-Line 与 Agent 通信；window-scoped Local Host + 远程连接注册表（ssh host-key / wsl distro+user / docker）；WSL 60s idle TTL。
- **两种链路**：`desktop-continuous`（trusted-host-relay，完整服务面）vs `web-remote-replayable`（terminal-client，受限）。
- **服务端**：Hono + node-ws；`/ws`(terminal-client)、`/ws/host`(trusted host)、`/api/connect-remote`、`/ws/remote/:id`；token 仅在配置 `authToken` 时启用；默认 listen localhost；非 loopback **fail-closed 抛错**；trusted-host 用一次性 30s TTL ticket 提权。

**kcode 决策**：N3 桌面/Web 直接复用这套形态结论（Electron utilityProcess 每窗口 host + stdio）。服务端采纳 Hono+node-ws + "默认 127.0.0.1、非本机必须显式 token"；kcode 额外要求远程 TLS（超出 ZCode，见 DESIGN.md §5.2）。

### 1.12 工程治理（architecture-policy.yaml + golden-module）

- `architecture-policy.yaml`：15 模块，仅 `storage` managed:true；global 阈值 `maxFileLines:400 / maxContractLines:300 / maxPublicMethods:12 / forbidCycles / forbidDeepImports / managedOnly:true`。
- 执行：`architecture:check --changed`，`verify:pre-push = lint + architecture:check`；**基线感知**——`.architecture-baseline.json` 按 sha256 记录存量违规，仅 newViolations 非零才 exit 1；`baseline:update` 手动。
- 规则集：max-file-lines / max-contract-lines / disable-count / max-public-methods / **domain-io（domain 层禁 node:fs/http/net/child_process/timers）** / layer-direction / ui-implementation-import / module-dependency / deep-import / cycle / expired-exception / missing-module-artifact。
- **golden-module**：managed 模块 = `module.ts`(id/requires/provides/publicEntrypoints) + `contract.ts`(窄端口接口) + `contract.example.ts` + `CONTRACT.md`(不变量)。

**kcode 决策**：这是 ZCode 最值得整体照抄的一层。kcode N1-1 从"dependency-cruiser warn→error"升级为**自建 `architecture-policy.yaml` 基线感知门禁 + golden-module 契约 + knip**。**优化点**：ZCode 的 `managedOnly:true` 导致实际只强制 storage 一个模块——kcode 应从第一天就让 core/runtime/session 等核心模块都 managed，避免门禁空转。

### 1.13 插件市场（CONTEXT.md）

5 类来源（官方市场=Builtin+CDN / Builtin / CDN / 个人 git·GitHub·URL·本地目录 / inline）+ 完整生命周期状态机（发现→安装→配置→启停→更新→卸载→恢复内置）。两关键态：**Restorable Builtin**（卸载后持久化抑制、不自动重播种）、**Orphaned Installed Plugin**（来源删除但目录/数据保留、可用不可更新）。元数据三分离：Store Listing（展示）≠ Plugin Manifest（`plugin.json` 功能）≠ Example Prompt（点击新建会话预填不自动发送）。

**kcode 决策**：N4-1 对标这套词汇与生命周期；N3-5 先补"加载期 hash 校验"（ZCode 的 seed 锁定我们已部分有，缺加载期重校验）。

### 1.14 专项包（对标与不对标）

| 包 | 功能 | kcode 决策 |
|---|---|---|
| formal-proof | d3 状态机可视化 | 不对标 |
| model-option-map | CEL 式 DSL 算逐模型选项 | 后置（kcode 用 AI SDK 路由即可） |
| zcode-cua | Computer Use **占位 fail-closed** | 不对标（kcode 也无此形态） |
| provider/provider-node | 模型配置纯逻辑 + 内置提供商下载/同步 | 部分：kcode 已有 providers 层，不抄内置下载链路 |
| dynamic-workflow(+runtime) | 工作流脚本编译器+执行 | N4-8 评估 |
| i18n | en-US/zh-CN | N4-7 采纳（两 locale 足够） |
| telemetry | OTel + 错误脱敏 | N4-3 采纳（opt-in + 假名化，kcode 已更强） |
| node-repl-host / browser-use-plugin | node_repl 宿主 + Playwright 浏览器 | N4-6 评估 |
| superpowers-plugin / swift-bridge | **占位（恒 false）** | 不对标 |

### 1.15 技能体系（.agents/skills + SKILL.md）

SKILL.md = YAML frontmatter（`name`/`description` 含触发词/`allowed-tools`/`disable-model-invocation`/`license`）+ Markdown 正文 + References/Templates。渐进加载：description 触发、正文命中才加载、references 按需读。architecture-governance 技能用"读 context 包 → 跑 architecture:check --changed → 基线感知报告"来管架构。

**kcode 决策**：kcode 已有 SKILL.md 渐进加载（metadata 常驻、命中加载正文）。**补**：`allowed-tools`（技能声明工具白名单，安全收益）+ `disable-model-invocation`（工具型技能只跑 CLI 不读正文）——这是 kcode 目前缺的两个 frontmatter 字段。

---

## 2. 交互体验对标

| 维度 | ZCode | kcode 现状 | 动作 |
|---|---|---|---|
| 输出分层 | 正文/工具卡片/thought 半透明/压缩 timeline 行 | 有流式+Markdown+工具状态行，但 spinner 随机动词 | N1-5 + M3：事件驱动状态、四层分明 |
| 输入 | return 提交、shift+return 换行、2-6 行自适应、word wrap | Ctrl+J 换行、多行输入已支持 | 对齐 shift+return；2-6 行自适应 |
| 主题 | 明暗自动探测 + 语义令牌 | 多处硬编码 `color="white"` | N1-5 设计令牌 + 终端亮度探测 |
| 详情浏览 | tool 卡片可展开、思考摘要独立折叠 | 详情浏览是 M3 待办 | N2-3 App.tsx 拆分后补 |
| 权限交互 | 审批与 hook 并发竞速、allow/deny/escalate/modify | 三态 + Shift+Tab 四档 | 已对标，缺 escalate/modify 裁决（后置） |
| 完成反馈 | 区分 completed/failed/aborted/limit_reached | M0-06 已落地 | 已对标 |

---

## 3. kcode 现状 → ZCode 差距矩阵

| 模块 | kcode 现状 | 差距 | 阶段 |
|---|---|---|---|
| 协议 | 无（localapi 已删） | 整套 v4 式协议 | N1-2 |
| RPC | 无 | stdio JSON-Line（简化版） | N3-1 |
| Agent 循环 | AgentLoop 单进程 | 已对标；缺单 turn 状态机显式化 | 微调 |
| 工具契约 | 各工具独立实现 | 统一 ToolEntry（schema+permission+resultBudget+timeout） | N2-3 |
| 工具清单 | 缺 ReadSessionContext/消息互通/后台控制/调度/EnterPlanMode 命名 | 补齐 | N2/N4 |
| 上下文 | 三层压缩，固定 10 条切片 | 按轮分组 + 锚点段 | N0-2/3 |
| 子代理 | task + .kcode/agents | 缺消息互通 | N2 |
| 准入 | runner busy 直接抛错 | RuntimeCommandQueue + reservation | N2-2 |
| exec | 有超时/后台/cd 持久 | OutputCollector 三段预算 | N2 |
| config | 有用户级/项目级 | 五级合并 + 深合并 | N2 |
| 治理 | dependency-cruiser warn | architecture-policy 基线门禁 + golden-module + knip | N1-1 |
| 设计令牌 | 硬编码 | text-ui-* + 语义色 | N1-5 |
| workspace 身份 | workspaceId 死接口 | identity/path 分离 | N0-6/N1-3 |
| 日志 | 散落 console.error | createServiceLogger + traceId | N1-4 |
| 插件市场 | 装卸 + 沙箱 v1 | 完整生命周期 | N4-1 |
| 桌面/Web/远程 | 占位 | host 协议 + Electron + Hono | N3 |
| i18n / 遥测 / 调度 / 电脑控制 | 无/接口/README | 对标 | N4 |

---

## 4. kcode 分步执行设计（细化到动作）

> 阶段编号与 DESIGN.md §8 一致；本节补**每个动作的详细设计思路 + 对标依据**。

### N0 会话一致性（P0）

| ID | 详细执行动作 | 设计思路（对标 ZCode） |
|---|---|---|
| N0-1 | `compactNow()` 改经 sink 落盘（`composition.ts:445-462`），补"压缩→关闭→恢复"回归 | 与 auto 压缩同源落盘；对标 ZCode 压缩写回 session |
| N0-2 | `compact.ts` 从"固定 10 条切片"改为"按 assistant 轮分组" | 对标 ZCode `rounds.ts`；保留最近 1 组为锚点段 |
| N0-3 | `compaction_summary` 事件加 `coverage`（覆盖哪些消息）+ `anchorMessageId` | 对标 ZCode `anchorMessageId=summaryMessageId` |
| N0-4 | `CheckpointStore` 落盘清单 + 前像 hash，重启可列出 | 对标 Claude Code 检查点语义 |
| N0-5 | `jsonl.ts` 定义截断/写失败/崩溃恢复语义 | append-only 崩溃恢复 |
| N0-6 | `ToolContext`/事件加 `workspaceKey`；`listSessions` 排序键改 `(workspaceKey, mtime)` | 对标 ZCode identity/path 分离（§1 第 4 点） |

### N1 契约与地基（P0–P1）

| ID | 详细执行动作 | 设计思路 |
|---|---|---|
| N1-1 | 新建 `architecture-policy.yaml` + `scripts/architecture-check.mjs`（基线感知）；core/runtime/session 标记 managed；golden-module 契约；knip 上 CI | 对标 §1.12；**优化**：核心模块全 managed，不学 ZCode 只强制 storage |
| N1-2 | `contracts/protocol.ts`：`PROTOCOL_MAJOR/MINOR` + `ProtocolHello{capabilities}` + `CommandEnvelope{commandId, baseRevision}` + 事件 `{logEpoch,seq}` + zod 运行时校验 + 一致性测试 | 对标 §1.1；先单文件，不做 v4 目录 |
| N1-3 | workspace 身份贯穿（`workspaceKey = identity?.trim() || path` + `normalizeWorkspacePathForIdentity`） | 对标 ZCode remote-workspace-identity.ts 归一化 |
| N1-4 | `createServiceLogger(scope)` + `packages/ui/src/logger.ts`；禁业务代码 console.log；debug 仅本地 | 对标 §1.10 serviceLogger |
| N1-5 | `packages/design/tokens.ts`（text-ui-* 尺度 + 语义色 + 单点 `--ui-font-size`）+ 终端映射器；替换 `color="white"` 硬编码 | 对标 §1.10 DESIGN.md |

### N2 多端地基（P1）

| ID | 详细执行动作 | 设计思路 |
|---|---|---|
| N2-1 | `contracts` 加 `IPlatformService`；CLI 改为经它访问平台能力（去直接 import platform） | 对标 ZCode platform.ts，字段裁剪到 cli/desktop/web |
| N2-2 | `SessionRunner` 加 `RuntimeCommandQueue`（priority now/next/later）+ 单 reservation；busy 时入队而非抛错 | 对标 ZCode §1.6 **简化版**（不做 500 行幂等网关） |
| N2-3 | `App.tsx` 拆 `theme/terminal/state/transcript/input/dialogs/status/`；工具统一 `ToolEntry` 契约；`packages/ui` 立包 + Zustand slice | 对标 ZCode ToolEntry + ui 组件拆分 |
| N2-4 | CLI bundle（tsup）+ 资源打包 + `latest.json` + sha256 + 安装脚本；摆脱 tsx | 对标 ZCode build:zcode 发行链 |
| N2-5 | 例外清零，门禁升 error | 对标 §1.12 B4 |

### N3 通道扩展（P2）

| ID | 详细执行动作 | 设计思路 |
|---|---|---|
| N3-1 | `apps/host` 子进程 + stdio JSON-Line 协议（stdout 只跑 RPC、stderr 分开）；`composeSession` 两种宿主 | 对标 ZCode zcodeStdioTransport |
| N3-2 | 凭证读取限定 host 进程；渲染进程拿 `probe(keyRef)` 布尔 | 对标 DESIGN.md §5.4 + ZCode provider 分层 |
| N3-3 | Web（React+Vite+Hono+node-ws）；默认 127.0.0.1，非本机显式 token；远程 TLS | 对标 ZCode §1.11 + kcode 加强 TLS |
| N3-4 | Desktop（Electron utilityProcess 每窗口 host + MessageChannelMain） | 对标 ZCode §1.11 |
| N3-5 | 插件加载期重校验 hash（排除 seed 自身） | 对标 threat-model B5 |

### N4 生态与云（P3+）

| ID | 详细执行动作 | 设计思路 |
|---|---|---|
| N4-1 | 插件市场（5 类来源 + 生命周期状态机 + Restorable Builtin/Orphaned） | 对标 §1.13 |
| N4-2 | IdP + relay E2E 消费者 + 远程对话 | E2E 层已落地，补 relay |
| N4-3 | 用量计量（假名化）+ 遥测（opt-in + 脱敏） | 对标 telemetry 包，kcode 假名化更强 |
| N4-4 | registry + Sigstore keyless + 扫描门 + seed + CRL | 供应链闭环 |
| N4-5 | cron 调度器 + automation 权限 + CronCreate/OffPeakCreate 工具 | 对标 ZCode automation 工具 |
| N4-6 | computer-use / browser-use（Playwright） | 对标 browser-use-plugin |
| N4-7 | i18n（en-US/zh-CN 两 locale） | 对标 §1.10 |
| N4-8 | dynamic-workflow 评估 | 对标 dynamic-workflow，倾向后置 |

---

## 5. 明确不对标（约束范围）

formal-proof、zcode-cua、swift-bridge、superpowers-plugin、postject bytecode、node-repl-host 独立宿主、OpenTUI 自研渲染器、自研二进制 RPC、飞书生态、多设备同步合并、Zai 主题变体、桌面九色工作流头像。

---

## 6. 与 DESIGN.md 的关系

- DESIGN.md §8 是**阶段与优先级**，本文 §4 是**每个动作的详细设计思路**。
- 冲突时以 DESIGN.md 为准；本文的技术细节是 DESIGN.md 的展开。
- 本文 §1 的 ZCode 剖析是**一次性事实快照**（提交 29628c9），ZCode 上游演进时按需复核。

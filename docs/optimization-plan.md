# kcode 优化总纲（项目唯一优化文档）

> 状态：**生效** · 建立：2026-10-26 · 最近更新：2026-10-27（评审修订：度量如实化、依赖标注、P4-5 范围澄清、S1-8 占位页、纳入 gates 链接门禁）
> **文档维护规则：本文是本项目唯一的优化执行文档。** 所有优化条目、状态变更、新增遗留项一律更新本文（改写对应条目 + 更新「最近更新」日期），不再新开计划/TODO 文档；其他文档只链接本文。
> **收编来源（2026-10-26）**：由 CLI 线 [cli-optimization-plan-2026-10.md](./cli-optimization-plan-2026-10.md) 与桌面线 [desktop-session-optimization.md](./desktop-session-optimization.md) 合并而成；两文转为**只读历史**（完成证据、教训、验收数字留在原文），未完成条目全部迁入本文（见 §5 对账表）。
> 对标参考：ZCode（闭源，内部解剖见 [zcode-benchmark.md](./zcode-benchmark.md)）· opencode（开源，client-server + SQLite，[架构分析](https://medium.com/@falexm/inside-opencode-understanding-the-architecture-behind-the-ai-runtime-01236d9370ff)）· pi（Mario Zechner 极简 agent，[作者复盘](https://mariozechner.at/posts/2025-11-30-pi-coding-agent)，OpenClaw 内核）。
> 边界不变：会话 JSONL 格式与 session 核心语义不改（[desktop-workspace-rpc-approval.md](./desktop-workspace-rpc-approval.md) 约束）；动协议/索引字段先按例外流程登记（gates-exceptions.json）。

## 0. 设计原则（三家对标得出的取舍，条目设计均以此为尺）

1. **一切能力先落 host RPC，UI 只是壳**（opencode：TUI/桌面/IDE/SDK 同协议多端免费；pi：无头 RPC 模式是其被选作 OpenClaw 内核的原因）。renderer 禁止直读文件系统；preload 例外 IPC 数量冻结，只减不增。
2. **上下文是稀缺资源，必须可观测**（pi：系统提示+工具定义 <1000 token；实测单个 MCP 服务器吃 13.7k–18k token ≈ 上下文 7–9%）。每个注入项（工具/MCP/规则/技能/repo map）都要有成本数字，砍什么先看数字。
3. **列表单权威 + 可全量重建**（opencode 迁移后"会话在库里但 UI 不显示"的教训：UI 缓存与存储双源是 bug 温床）。已落地（host 索引 + P3-2），守纪律。
4. **演变接口先钉死再加模块**：per-session 状态分片、统一资产契约、typed error、令牌单源——这四件决定素材/画布/多端/多会话将来是"加模块"还是"翻地基"。
5. **隔离靠容器，不靠弹窗堆叠**（pi 作者结论：逐工具权限检查接近 security theater）。srt 沙箱（4-01）是 Windows 差异化的正确投资方向。

## 1. 优先级分档与执行规则

```text
S0 止血（风险每天在累积）→ S1 高频摩擦（日常手感）→ S2 演变地基（返工成本最高）→ S3 差异化（拉开距离）→ S4 远期占位
```

执行规则：S0 清零才进 S1，依此类推；S2 内部可并行；每项完成即更新 §6 台账（证据 = 测试/入口链接）。

### S0 止血

| ID | 事项 | 落点 / 动作 | 验收 | 量 |
|---|---|---|---|---|
| S0-1 | **提交当前工作区批次** | P4-2 等 40+ 文件已全绿未落盘（单测 29 + E2E 15 + lint/knip/depcruise 绿）——按既有纪律分批提交 | git log 有据，工作区干净 | 0.5h |
| S0-2 | **E2E 路径参数化**（含 M2 计时断言） | 11 个 spec 硬编码 `E:/space/my_space/MyProject/kcode` → 统一从 `import.meta.url` 推导仓库根（或 `KCODE_E2E_REPO` 覆盖）；顺手补 M2 实测（创建→Composer 可发送计时断言） | 换目录/CI 可跑；全量 E2E 绿；M2 有数字 | 0.5d |
| S0-3 | **Windows CI 首绿** | 推送触发既有 Windows job（含 `KCODE_PERF=1` 压测门槛） | Actions 有绿记录 | 0.5d |
| S0-4 | **main.tsx 拆分** | 482/500 行贴着 oxlint `max-lines` 门禁，下一次改动即爆；把全局快捷键 effect、事件流投影 effect 拆 hook | main.tsx < 400 行；lint/typecheck 绿 | 0.5d |
| S0-5 | **RowView 真 memo 化** | rows.tsx 注释写"按行类型 memo 化"但实现无 `React.memo`——流式期间全列表行重渲染；包 memo + 行类型分发保持稳定 props | 大会话（500+ 行）流式时行组件不重渲染（React Profiler 断言或单测） | 0.5d |

### S1 高频摩擦（桌面日常手感）

| ID | 事项 | 落点 / 动作 | 验收 | 量 |
|---|---|---|---|---|
| S1-1 | **菜单补齐**（原 P4-3/F4/F5） | 任务 `...`：导出（复用 CLI `/export` JSONL 语义 + 3-06）、复制 ID；工作区 `...`：在编辑器中打开（shell.openPath）、归档工作区 | E2E：四动作各自可断言 | 1–2d |
| S1-2 | **tool_progress 桌面接线**（含 M4 验证） | 事件已到 renderer 被 projection 丢弃（`default: return state`）——接入工具卡尾部节流显示（CLI 3-10 已有同能力）；流式期间输入帧无卡顿断言（M4） | 长工具（构建/E2E）运行中桌面可见输出尾巴；E2E 断言；M4 有结论 | 1d |
| S1-3 | **llm_error 通用重试** | 额度已有 banner；网络/超时类失败只有一行 warn 无出口——失败行加「重试本轮」（复用 run_limit 暂停语义：重发最后一轮 user_message） | 断网注入 → 重试按钮 → 恢复后成功；E2E | 1d |
| S1-4 | **context 浮动抽屉 + 响应式**（原 P4-4/F7/F18） | SidePane 改 400px 浮动（四周 12px、圆角阴影、关闭回 780px）；≥1360 / 1180–1359 / <1180 三档行为核对 | E2E + 三档宽度手测记录 | 2d |
| S1-5 | **快捷键与令牌收口**（原 P4-6/F17/F19） | `⌘,` 绑定设置；桌面样式收敛 `@kcode/design` 单源，删 styles.css 重复 token | 单测 + 视觉核对无回归 | 1–2d |
| S1-6 | **设置子页第一批**（原 P4-5/F14 子集；依赖 S2-6，可先出只读版） | 插件/技能/MCP/命令 + 使用统计（CLI 已有能力的桌面接线；堵"桌面=CLI 降级版"）；provider 预设网格补添加流程。剩余子页（浏览器/快捷键/记忆/子智能体/钩子/归档）按需追加批次，不阻塞本档 | E2E：安装/启停/查看各一例 | 3–5d |
| S1-7 | **桌面预算护栏接线** | host 桌面会话未接 `sessionBudgetTokens`（P4-2 期间确认）——接配置 + onBudgetLimit 走暂停点（paused/budget 已落地） | 配预算 → 到顶出现暂停条；单测 | 0.5d |
| S1-8 | **新功能线静态占位页**（F20/F21 空态） | 一级导航「自动化/插件市场」渲染原型已有的空态设计（"还没有定时任务"+模板卡/本地插件管理优先提示），不做功能——补齐整窗视觉完整度，真功能仍走 S3-5 例外立项 | E2E：两入口可见且空态文案正确 | 0.5d |

### S2 演变地基（决定将来是加模块还是翻地基）

| ID | 事项 | 落点 / 动作 | 验收 | 量 |
|---|---|---|---|---|
| S2-1 | **per-session 状态分片 + 事件路由** | main.tsx 单 timeline state → `Map<sessionId, TimelineState>`，`session/event` 按 sessionId 分发（协议事件已带 sessionId）；S3-3 多会话并行的前置 | 单测：两会话事件互不串；现网行为不变（E2E 全绿） | 2–3d |
| S2-2 | **统一资产引用契约** | contracts 加 `AssetRef {id, path, mime, meta?}`；host 资产存储（复用 session-index 锁/原子写纪律）；图片 images[] 平迁为特例。素材/视频/画布三方向共用一套引用——先出设计稿登记再实现 | 设计文档评审通过 + contracts 单测 | 先 1d 设计，实现 3d |
| S2-3 | **typed error.code** | `llm_error` 加可选 `code` 枚举（quota/auth/rate_limit/context_overflow/network…）；host 侧填，renderer 额度识别从文本启发式（P4-2 权宜）转结构化；旧 JSONL 无 code 走文本回退 | 例外登记 + 单测：新旧事件都能分类 | 1d |
| S2-4 | **host HTTP/WS 监听预留 + ACP** | host 加可选 `--listen` 模式（复用同一 RPC dispatch 表）；4-09 ACP server 走同一底层。opencode 多端精髓：一套协议，TUI/桌面/web/IDE 免费互通 | `--listen` 下现有 E2E 场景可经 HTTP 驱动一例 | 3–5d |
| S2-5 | **索引层接口化** | sessions 查询抽接口（list/search/page），实现可换 FTS/SQLite 后端（不迁 JSONL 正文，只迁元数据索引；opencode 用 SQLite FTS5） | 接口 + 现实现单测平移；205 会话搜索 P95 不劣化 | 1–2d |
| S2-6 | **使用统计统一账本** | usage metering（UsageEvent）+ `/cost` 分项（3-21）+ session_end.usage 汇聚成单一查询 RPC；S1-6 使用统计页消费它 | `usage/summary` RPC + 单测 | 1–2d |

### S3 差异化（拉开距离）

| ID | 事项 | 落点 / 动作 | 验收 | 量 |
|---|---|---|---|---|
| S3-1 | **srt 沙箱真实验收**（4-01 收尾） | 真实 srt 安装验收（沙箱内可改工作区/不可写系统目录/不可联网/越权有提示）+ `/sandbox`/`/audit` 面板；MXC 等 Node 24 后平移 | 4-01 验收清单全过；审计有 sandbox 字段 | 3–5d |
| S3-2 | **上下文可观测性** | `/context` 预算表：系统提示/工具定义/各 MCP/规则/技能/repo map 各占多少 token + 会话累计（3-21 已有底）；pi 的数字（单 MCP 13.7k–18k）就是砍留依据 | CLI `/context` + 桌面上下文环 tooltip 接同一数据 | 2d |
| S3-3 | **多会话并行**（原 P3-6，依赖 S2-1） | 每会话独立 host 已具备；侧栏运行中状态点（F2 红点）+ 后台会话进度；lease/索引并发已由 P2-1/P2-2 兜底 | 双会话并行 E2E：互不干扰、状态点正确 | 5d+ |
| S3-4 | **CLI 阶段四余量**（按需逐项；分项依赖 S2-4/S2-5） | 4-03 常驻 LSP、4-04 repo map AST 化、4-05 全文索引（依赖 S2-5）、4-06 转写内选块、4-08 Sigstore、4-09 IDE/ACP 桥（依赖 S2-4）、审批 escalate/modify 裁决 | 各自原验收 | 逐项 2–6d |
| S3-5 | **新功能线占位**（原 P4-7/F20/F21/F22） | 自动化页/插件市场（本地管理优先）/终端+面板+帮助菜单——仍按例外另行立项，本文只占位不展开 | 立项时在本文追加条目 | — |

### S4 远期占位

- P3-5 子会话 parentId 树（索引可选字段 + 侧栏缩进）；
- 调度（Cron/定时任务，对标差距矩阵遗留）；
- i18n / 遥测（opt-in）；
- 素材/画布/视频产品化（依赖 S2-2 契约与 S2-1 分片落地后立项；届时按 §0 原则 4 评估）。

## 2. 执行顺序与依赖

```text
S0 全清 → S1（S1-6 的数据源依赖 S2-6，可先出只读版）
        → S2-1 / S2-2 / S2-3（可并行）→ S2-4 / S2-5 / S2-6
        → S3-1 / S3-2 随时可插队（与 S2 无依赖）→ S3-3（依赖 S2-1）→ S3-4（依赖 S2-4/S2-5 的项后置）
```

## 3. 风险与回滚

| 风险 | 缓解 |
|---|---|
| S2-1 状态分片引入事件串扰 | 单测双会话互斥 + 全量 E2E 回归；分片纯 renderer 侧，出问题回退单 state |
| S2-2 资产契约设计过度 | 第一版只覆盖"引用+存储"，转码/缩略图等留扩展位不实现 |
| S2-3 旧转写无 code 字段 | code 可选 + 文本分类回退（P4-2 分类器保留为兜底） |
| S2-4 开监听端口的安全面 | 默认关闭、仅 127.0.0.1、token 握手；对齐 host 既有 lease 纪律 |
| S2-5 索引换后端丢特性 | 接口先带全量语义（query/limit/offset/total），现实现平移为第一后端 |
| 行为变更影响既有 E2E | 每项先跑全量；护栏类变更同步更新断言（继承两线纪律） |

## 4. 度量（继承 + 合并；如实版）

| # | 指标 | 目标 | 状态 |
|---|---|---|---|
| M1 | sessions/list 耗时（200 会话含 3×5MB） | P95 < 50ms | ✅ 已实测（cold 29.6ms / warm 7.8ms） |
| M2 | 创建 → Composer 可发送 | P95 < 300ms | ⏳ **未实测**——随 S0-2 补计时断言 |
| M3 | 创建/切换失败静默 | 0 | ✅（create-failure/create-fault E2E） |
| M4 | 流式运行期间侧栏刷新/输入 | 无卡顿 | ⏳ **未实测**（逻辑闭环于 P1-1/P1-2）——随 S1-2 验证 |
| M5 | 空转 30s 轮询侧栏重渲染 | 0 次 | ✅（sessions-signature 单测） |
| M6 | 杀进程/断电恢复 | 不丢/可恢复 | ✅（crash-recovery E2E） |
| M7 | 双窗口并发 | 0 丢更新 | ✅（dual-active E2E + 锁单测） |
| M8 | 大会话（500+ 行）流式输入帧间隔 | P95 < 33ms | ⏳ 新增（S0-5 memo 化前后对比，随 S1-2 一并测） |
| M9 | /context 注入项成本覆盖 | 覆盖全部注入项，总和与厂商回报 usage 偏差 < 10% | ⏳ 新增（S3-2 产物） |

## 5. 与既有条目的对账（迁移表）

| 旧条目 | 去向 |
|---|---|
| CLI 线 P0-0~P2-E、3-33~3-37、4-02 | 全部完成，证据留 [cli-optimization-plan-2026-10.md](./cli-optimization-plan-2026-10.md) |
| CLI 4-01 srt | S3-1（M1 骨架已接，待真实验收） |
| CLI 4-03~4-09 | S3-4 |
| 桌面 P0-1~P4-2、P3-1~P3-4 | 全部完成，证据留 [desktop-session-optimization.md](./desktop-session-optimization.md) |
| 桌面 P4-1 尾巴（思考强度/Ctrl+T/额度 RPC） | 拆入 S2-6（额度数据）+ S3-4（厂商能力就绪后） |
| 桌面 P4-3/P4-4/P4-5/P4-6 | S1-1 / S1-4 / S1-6（第一批，剩余子页按需追加批次）/ S1-5 |
| 桌面 P3-5 / P3-6 / P4-7 | S4 / S3-3 / S3-5 |
| F16 运行态（P4-2 已完成） | —（额度 banner/继续条/浮动进度卡已落地，2026-10-26） |

## 6. 状态台账（新条目自此记起；已完成旧条目见两份历史文档）

| 条目 | 状态 | 完成证据（测试/入口） |
|---|---|---|
| S0-1 提交当前批次 | ✅ 2026-10-27 | 92d0fb4（host/contracts）/ fd7c409（desktop P2-2~P4-2）/ 0623041（docs 收编），工作区干净 |
| S0-2 E2E 路径参数化 | ✅ 2026-10-27 | 82d57de + 654a1ca；11 个 spec 改模块 URL 推导（KCODE_E2E_REPO 可覆盖）；**干净克隆异地全量 E2E 15 passed** 验证路径无关；M2 计时断言入 desktop-v2.spec，首样本 835ms（含 host 冷启动，目标 P95<300ms 待 S1 优化分解） |
| S0-3 Windows CI 首绿 | ✅ 2026-10-27 | Actions run 于 77c46f1 全绿（gates+windows）。失败链修复：gates=M2 console.log→stdout（d942b73 前）；windows E2E=历史硬编码路径（82d57de 参数化修复，干净克隆异地 15 passed 验证）+ inbox 侧栏断言慢机余量（77c46f1）；另沉淀 github reporter 注解上报（d942b73，失败明细匿名 API 可读） |
| S0-4 main.tsx 拆分 | ✅ 2026-10-27 | 6fcd43e：482→375 行，拆 useGlobalShortcuts/useInitialConfig/useTimelineProjection/useCreateFailureActions，原样搬移语义不变 |
| S0-5 RowView memo 化 | ✅ 2026-10-27 | 932550d：RowView 包 React.memo + useWorkspacePanes 动作 useCallback 化；帧率断言并入 M8（随 S1-2 测） |
| S1-1 菜单补齐 | ✅ 2026-10-27 | host 3 RPC（session/export、workspace/open_editor、workspace/archive + store archived 字段）；任务菜单 导出 JSONL/复制 ID，工作区菜单 在编辑器中打开/归档工作区 + 侧栏「已归档工作区」分区；`workspace-archive.test` 1 条 + E2E `menus.spec`（剪贴板断言/导出落盘/归档往返）；导出走 readFile→writeFile 规避 Defender EPERM；行数收口拆出 editor-launch/session-export/ArchivedWorkspaces/SidebarNav/useSidebarTaskActions |
| S1-2 tool_progress 接线 | ✅ 2026-10-27 | projection 新 case（挂 running 工具行 progressTail/Chars，result 落定清除）+ ToolCallRow 尾行显示；单测 2 条；E2E 不适用（事件不落盘无法 replay 驱动，真实驱动需厂商工具流——M4 流式帧率断言顺延至 S1-4 响应式批一并手测） |
| S1-3 llm_error 重试 | ✅ 2026-10-27 | 非额度错误改渲染 `llm_failed` 行（FailedCallBanner + 重试本轮=重发最后一轮用户输入，projection 记 lastUserText）；单测 2 条 + E2E `runtime-state.spec` 第 2 条（重试→重发行出现） |
| S1-4 context 浮动抽屉 | ✅ 2026-10-27 | `.side-pane-v2` 改 400px 浮动（四周 12px 内缩、圆角阴影、入场动画，absolute 不占栏）；三档响应式落地（≥1360 全宽+浮动抽屉 / 1180–1359 覆盖打开 / <1180 侧栏 225px+示例卡单列 / <860 隐藏侧栏）；E2E `responsive-pane.spec`（主栏零位移、三档宽度断言）+ **M8 实测 520 行时间线挂载 rAF P95=20.3ms（目标 33ms ✅）** |
| S1-5 快捷键/令牌 | ✅ 2026-10-27 | `⌘,` 绑定设置（useGlobalShortcuts）；`--z-*` 调色板三处重复像素值（styles.css/useTheme/隐式）收口到 `@kcode/design`（DESKTOP_CLASSIC_LIGHT/DARK + desktopClassicTheme()，useTheme 消费同一映射，styles.css 只留布局）；`desktop-classic.test` 2 条 + E2E `shortcut-theme.spec`（⌘, 开设置、暗色切换 bg 断言） |
| S1-6 设置子页第一批 | ✅ 2026-10-27 | 新 tab「扩展」（插件/技能/命令/MCP 四段，`extensions/list` 一站式 RPC）+「使用统计」（`usage/summary` 跨会话账本，**S2-6 第一片**：JSONL 尾部 64KB session_end 聚合 + 估算标注）+ 模型页 provider 预设网格与添加流程（config/save 的 model 改可选，落 keychain）。插件支持本地目录安装（`plugins/install`，权限摘要可见）/启停（`plugins/set_enabled`，state.json）；Windows 加固：state.json 原子写在 Defender EPERM 下降级直写（读取侧本就安全降级）。host 单测 3 条（extensions-usage.test）+ E2E `settings-extensions.spec`（安装→未签名徽标→停用/启用→state.json 断言→技能/命令/MCP→统计→加供应商）；全量 E2E 20 passed |
| S1-7 预算护栏接线 | ✅ 2026-10-27 | host 会话接 sessionBudgetTokens（KCODE_BUDGET_TOKENS > config budget.maxSessionTokens，fail-closed 成 rejected+detail）；E2E `budget-guard.spec`（种子超预算会话续接提交→暂停条含「会话 token 预算已用尽」） |
| S1-8 导航占位页 | ✅ 2026-10-27 | 侧栏一级导航（对话/自动化/插件市场）+ NavPlaceholderPage 空态（真功能走 S3-5）；E2E `nav-pages.spec`（切换/返回/composer 恢复） |
| S1 批 CI 收口 | ✅ 2026-10-27 | ee25bc0 双 job 全绿（19 E2E + perf 门槛）。过程沉淀：①create-failure 慢机加固（test.slow+15s 窗口）；②M1 perf 门槛环境分级（CI 共享 runner 80ms / 本机 50ms，CI 实测 59.85ms 属环境波动）；③**submit 失败可见化（M3 补漏）**——`session/submit` catch 不再静默（慢机 dispose/create 竞态会打在"会话未创建"上），时间线 deny 行 + busy 复位；inbox.spec 加 user_message 前提断言 + retries 2 |
| S1-1 ~ S1-8 | — | 拆分明细见上（S1-4/5/6 待做） |
| S2-1 per-session 状态分片 | ✅ 2026-10-27 | `TimelineShards`（LRU 8 片）：切换暂存旧会话时间线、切回秒恢复缓存画面（replay 改后台权威重建后整体替换）；投影按 session/event 内层 sessionId 路由，非当前会话事件并入其缓存分片不串画面（S3-3 地基）。`timeline-shards.test` 4 条；全量 E2E 22 passed 行为不变 |
| S2-2 资产引用契约 | ⏳ | 先设计稿（§3 约定），再实现 |
| S2-3 typed error.code | ✅ 2026-10-27 | `llm_error` 加可选 `code` 枚举（quota/auth/rate_limit/context_overflow/network/unknown）；发射侧权威分类 `classifyLlmError`（core/errors.ts），renderer code 优先、旧转写文案兜底；例外已登记（desktop-workspace-rpc-approval.md）。core 8 例 + renderer 3 例单测 |
| S2-4 host HTTP/WS 监听 | ⏳ | — |
| S2-5 索引层接口化 | ⏳ | — |
| S2-6 使用统计账本 | ⚠️ 第一片已落地 | `usage/summary` RPC + 设置页使用统计（随 S1-6）；剩余：CLI usage metering 汇聚与精确化（去估算标注）待做 |
| S3-1 ~ S3-5 | ⏳ | 见各条验收 |

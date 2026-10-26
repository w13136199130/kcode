# kcode 桌面会话/工作区优化方案（唯一优化文档）

> 状态：**生效** · 最近更新：2026-10-26
> 范围：桌面侧「工作区/任务列表 + 会话创建/切换」体验的稳定性、流畅性、数据不丢。
> **文档维护规则：本文是本项目桌面优化线的唯一文档。** 后续优化、状态变更、新增遗留项一律更新本文（改写对应条目 + 更新「最近更新」日期），不再新开计划/TODO 文档；其他文档只链接本文，不重复维护清单。
> 边界：CLI 主线仍以 [cli-optimization-plan-2026-10.md](./cli-optimization-plan-2026-10.md) 为唯一执行文档（两条线互不合并）。会话文件格式、CLI/TUI 行为、session 核心语义不修改（[desktop-workspace-rpc-approval.md](./desktop-workspace-rpc-approval.md) 约束）。
> 参考：原型 [desktop-ui-design.md](./desktop-ui-design.md)（v23）· 落地历史 [desktop-ui-implementation-plan.md](./desktop-ui-implementation-plan.md) · 审计 [desktop-ui-audit.md](./desktop-ui-audit.md)

## 0. 目标与验收度量

四条创建/切换链路（新建会话并添加工作区、工作区下新建会话、新建普通会话、切换分组后新建会话）与两个列表（工作区分组列表、任务/未分组列表）做到：**不丢数据、失败可见可恢复、列表刷新无感**。流畅度对标 ZCode 并争取反超（反超点：增量数据链路 + 无变化零重渲染，ZCode 侧栏是全量刷新模型）。

| # | 指标 | 目标值 | 度量方式 |
|---|---|---|---|
| M1 | `sessions/list` 耗时（200 会话，含 3 个 ≥5MB 大会话） | P95 < 50ms | host 单测计时 + 压测 fixture |
| M2 | 创建 → Composer 可发送 | P95 < 300ms | E2E 计时 |
| M3 | 创建/切换失败静默 | 0（必须有提示 + 重试入口） | E2E 断言（fault 注入） |
| M4 | 流式运行期间侧栏刷新 | 输入帧无卡顿；host 列表扫描不阻塞事件转发 | E2E + 手测 |
| M5 | 空转 30s 轮询 | 0 次侧栏重渲染（结果无变化时） | renderer 单测 |
| M6 | 杀进程/断电恢复 | 会话不丢（draft 可见可续）、索引不损坏、无孤儿条目 | `create-fault` / `crash-recovery` E2E |
| M7 | 双窗口并发（同会话打开、同索引写） | 0 丢更新；第二窗口收到明确拒绝文案 | 并发 E2E |

## 1. 竞品设计与借鉴

### 1.1 opencode（开源，可直接借鉴架构）

- **存储**：单一 SQLite 库（`~/.local/share/opencode/opencode.db`），0.1.x 起从每会话 JSON 文件迁移而来。收益：写入并发安全（WAL）、列表/分页/搜索走索引，天然没有"每次列表全量读所有文件"的问题。
- **组织**：项目=目录维度；桌面端 Home 视图按项目列出会话。
- **教训**（公开 issue 可查）：存储迁移后出现"项目列表在、会话显示 0 条"“会话在库里但 UI 不显示”这类 UI 与存储脱节的 bug——说明**列表必须只有一个权威源且可全量重建**，双源合并（UI 缓存 vs 存储）是 bug 温床。

**取舍**：我们会话正文保留 JSONL（与 CLI 一致、例外文档禁止改格式），**不迁 SQLite**；但把"列表元数据层"做成 opencode 式的单点权威（host 索引）+ 增量缓存查询，达到同样的列表性能特征。

### 1.2 ZCode（闭源，借鉴交互）

- 工作区=项目、任务=会话，同级树；新建任务在侧栏顶部，创建即时可用（乐观创建 + draft 占位）；
- 多窗口侧栏实时同步；并行任务（多会话同时运行）。

我们已具备乐观创建雏形（requestId 幂等 + draft 状态机），本方案把它补完到「失败也可见」。并行多会话受 host「每窗口最多一个活动会话」模型限制，列为远期项。

### 1.3 结论

列表层学 opencode（单权威 + 索引化 + 增量），创建层学 ZCode（乐观 + 幂等 + 失败可恢复），再加我们自己的强项：故障注入 E2E 兜底（M3/M6/M7）。

## 2. 现状与差距（按模块）

### 模块 A：列表数据链路（流畅性根因）

现状：每次 `sessions/list` → `listSessions()`（[packages/runtime/src/session/resume.ts](../packages/runtime/src/session/resume.ts)）`readdir` 后对**每个** `.jsonl` 整文件 `readFile` + 全量解析 + 每会话再读 title sidecar → `reconcileSessionIndex` 可能整表重写。触发源：30s 轮询、`sessions/changed` 事件（fs.watch 300ms 防抖，活跃会话流式写入期间持续触发）、activityKey 变化。renderer 侧 `setSessions` 每次换新数组 → 两层 useMemo 重算 → 整树重渲染（无变化也渲染）；`main.tsx` 的 `conn.events.filter(...)` 每渲染重扫事件数组。

差距：M1/M4/M5 全不达标。

### 模块 B：会话创建/切换链路（可靠性）

现状四条流程（均 `dispose → create(requestId)`，见 [useDesktopSessionSwitching.ts](../apps/desktop/src/renderer/hooks/useDesktopSessionSwitching.ts)、[main.tsx](../apps/desktop/src/renderer/main.tsx)）：

| 流程 | 入口 | 现状 | 缺陷 |
|---|---|---|---|
| 新建会话并添加工作区 | 侧栏 📁+ → `pickDirectory` → `workspace/add` → 信任确认 → `workspace/trust` → 立即 `onNewSession(path)` | 已实现 | 失败静默（见下） |
| 工作区下新建会话 | 工作区行 `+` / `...新建任务`；或选中工作区后顶部「新建会话」（`targetPath=selected`） | 已实现 | 同上 |
| 新建普通会话 | 顶部「新建会话」/ Ctrl+N / 启动自动创建（重试 3 次） | 已实现 | 同上；启动重试上限后无提示 |
| 切换分组后新建会话 | 点工作区行 → `selected` 切换 → 新会话进该工作区 | 已实现 | 同上 |

关键缺陷：

1. **失败静默**：`onNewSession`/`onResume` 的 `.catch(() => undefined)`——create 失败后 `sessionId` 停留 null，Composer 永久禁用，无提示无重试（打开文件夹流程有报错行，其余没有）。
2. **护栏不一致**：`onPickWorkspace` 运行中拒绝切换并提示，但 `onNewSession`/`onResume`/Ctrl+N 没有同样护栏——运行中新建会 dispose 正在运行的会话（fail-closed 结算未决交互），任务被静默中止。
3. **lease 拒绝无文案**：第二窗口打开另一窗口正在使用的会话时，host lease（前持有者 pid 存活→拒绝）会报错，落到同一个静默 catch。
4. **归属双源**：分组归属 = host 索引 workspaceKey + renderer localStorage（`rememberSessionWorkspace`/`listLocalSessions`）三向合并，规则分散在 `useSidebarSessions`/`DesktopSidebar` 两处。

### 模块 C：分组语义（与原型 v23 的偏差）

原型要求：**点击「任务」标题后，新建任务进入「任务/未归类」**；没有任何工作区时新建直接进「任务」。现状：「任务」标题点击只做折叠展开（`tasksOpen`），新建目标永远是某个 cwd 对应的工作区——桌面创建的会话必然有 workspaceKey，「任务」组只收旧 CLI 无 key 会话。语义缺失，非 bug。

### 模块 D：并发与一致性

- `session-index.json` 仅进程内串行（`serial()` 队列）+ 临时文件 rename；多窗口=多 host 进程并发 read-modify-write 会丢条目，reconcile 整表重写可能清掉对方刚写的 draft——表象就是"列表条目偶发消失"（违反 M7）。
- 双活写保护（host_lease epoch + pid 存活检查）有实现、无测试；requestId 复用路径（`prior.status==="active"` → `resumeFrom` 续写已有文件）新引入双写场景，恰是 lease 要防的。

### 模块 E：功能项（前排观察，不急）

索引搜索/分页（当前全量返回 + renderer 截 200）、回收站保留期（约束"不自动清理"，属策略决策）、子会话 parentId 树。

### 模块 F：原型 v23 全量功能对账（2026-10-26 补齐）

原型（[desktop-ui-design.md](./desktop-ui-design.md) v23）共 22 个功能模块，此前优化分析只覆盖会话/工作区/列表/创建链路（模块 A–E），本表补齐其余模块。图例：✅ 已落地有入口 · ⚠️ 部分落地（有差距）· ❌ 未落地。差距项全部收入 §3 P4。

| # | 模块 | 状态 | 说明 / 差距 |
|---|---|---|---|
| F1 | 侧栏顶部品牌/本地徽标 | ✅ | `DesktopSidebar` d2-head |
| F2 | 工作区/任务树（同级分组/折叠/搜索/排序/📁+/行高） | ✅ | 含整体折叠、单工作区折叠；红色状态点（未处理任务）未做 |
| F3 | 新建会话四流程 + 信任 | ✅ | 缺陷见模块 B/C（P0/P3-1） |
| F4 | 任务菜单 | ⚠️ | 重命名/归档/删除(回收站)✅；**导出、复制 ID 未落地** |
| F5 | 工作区菜单 | ⚠️ | 新建任务✅；**在编辑器中打开、归档工作区未落地**（删除工作区有） |
| F6 | 时间线（流式跟随/脱离吸底/工具卡/失败末尾） | ✅ | Timeline.tsx 吸底+脱离已有；「回到底部」按钮文案对齐归入打磨 |
| F7 | 变更卡 + context 浮动抽屉 | ⚠️ | diff 详情栏/变更卡已落地；**400px 浮动抽屉形态未做**（现为常驻 SidePane） |
| F8 | 审批四档（1–4 键/风险/文件/审计） | ✅ | D0–D2 落地 |
| F9 | 计划/提问面板 | ✅ | PlanPanel / AskPanel |
| F10 | 空态（信任 banner + 三张示例卡） | ✅ | EmptyState 三卡填入 composer |
| F11 | Onboarding（目录/厂商预设/key 钥匙串） | ✅ | 稍后配置出口已有 |
| F12 | Composer v2 | ⚠️ | 附件/权限模式/发送/队列/图片排队✅；**上下文容量环+额度、模型+思考强度面板、Ctrl+T 未落地** |
| F13 | 命令面板 ⌘K | ✅ | CommandPalette |
| F14 | 设置全页 | ⚠️ | 骨架+模型/外观/权限/关于✅；**provider 预设网格细节、浏览器/快捷键/记忆/子智能体/插件/MCP/技能/命令/钩子/使用统计/归档子页未落地** |
| F15 | 暗色主题 | ✅ | useTheme（system/light/dark） |
| F16 | 对话运行态 | ⚠️ | 任务面板/后台任务可见✅；**额度 banner+重置入口、暂停点「继续」按钮、进度卡 `2/5`+子智能体卡未落地** |
| F17 | 全局快捷键 | ⚠️ | ⌘K/⌘B/⌘N/Esc✅；**⌘,（设置）未绑定；⌘T 依赖 F12 思考强度** |
| F18 | 响应式三档宽度 | ⚠️ | 未验证 1180/860 断点行为（列入 P4 打磨核对） |
| F19 | 设计令牌单一来源 | ⚠️ | 桌面未引用 `@kcode/design`，`styles.css` 自持 token（原型要求落在 packages/design） |
| F20 | 自动化页 | ❌ | 一级导航「对话/自动化/插件市场」仅对话——新功能线 |
| F21 | 插件市场页 | ❌ | 新功能线（本地插件管理优先） |
| F22 | 终端/面板/帮助菜单（底部终端/新标签页/帮助） | ❌ | 新功能线 |

归类：F4/F5/F7/F12/F14/F16/F17/F18/F19 是**既有能力的补齐/打磨**，进优化队列（P4）；F20/F21/F22 属新功能开发，受 D3 冻结约束，不在本文优化范围（立项时按例外流程登记，并在本文追加条目占位）。

## 3. 优化方案（按优先级）

> 执行规则：P0 全部完成并验证后才进 P1，依此类推；每项完成即更新本文状态标记。

### P0 可靠性地基（不丢数据、失败可见）

**P0-1 收口当前批次** ⏳
工作区现有 14 文件改动 + 3 个 E2E（requestId 幂等 / draft 状态机 / fs.watch 多窗口刷新 / 故障注入）：跑 host 单测 + desktop E2E，绿后提交。

**P0-2 创建链路失败可见 + 可重试** ⏳
- 落点：`useDesktopSessionSwitching.ts`、`main.tsx`（启动创建）、`Composer.tsx`。
- 设计：抽出统一的 `createDesktopSession(cwd, opts)`：失败 → timeline 警告行（含错误文案）+ 「重试」动作 + Composer 恢复到可发送的空态（回到上一个可用会话或欢迎页）；启动自动创建重试耗尽同样提示。lease 拒绝错误码识别为专属文案「该任务正在其他窗口使用中」。
- 验收：M3；fault 注入 E2E 断言失败后 UI 有提示且可重试成功。

**P0-3 运行中切换/新建护栏统一** ⏳
- 落点：`useDesktopSessionSwitching.ts`（`onNewSession`/`onResume` 入口）、Ctrl+N handler。
- 设计：与 `onPickWorkspace` 一致——`timeline.busy` 时提示「运行中不能切换（先停止或等待本轮完成）」。不做静默 dispose。多会话并行见 P3-6。
- 验收：E2E：流式中 Ctrl+N / 点工作区 `+` → 出现提示、当前任务继续运行。

### P1 流畅性主体（列表数据链路增量化）

**P1-1 `listSessions` 增量缓存** ⏳
- 落点：`packages/runtime/src/session/resume.ts`（或 host 侧独立 cache 模块，避免影响 CLI 调用方——倾向 host 内 `session-summary-cache.ts`，CLI `listSessions` 保持原语义）。
- 设计：进程内 `Map<sessionId, {mtimeMs, size, summary}>`；`stat` 后 mtime+size 未变直接用缓存；变化才读文件且**只读头部**（前 64KB）取 `session_start` + 首条 `user_message`；`turns` 放宽为「有内容」近似值（显示用途）；title sidecar 同样按 mtime 缓存。`sessions/list` 与 `reconcile` 复用同一缓存，reconcile 只处理变化项。
- 验收：M1；单测：改 mtime 后摘要更新、未变文件零读取（计数器断言）。

**P1-2 renderer 节流** ⏳
- 落点：`useSidebarSessions.ts`、`main.tsx`。
- 设计：`sessions/list` 结果先做稳定签名（sessionId|updatedAt|title|draft 串接）比较，无变化不 `setState`；`sessionsSignal` 连续变化 200ms 合并重拉；`conn.events.filter` 从 render 移到 effect 内累计计数。
- 验收：M5；单测：同结果重复拉取不触发重渲染。

**P1-3 压测 fixture 与指标脚本** ⏳
- 200 会话（含 3×5MB）fixture 生成脚本 + M1/M4 计时断言，进 CI（Windows job）。

### P2 多窗口一致性

**P2-1 session-index 跨进程锁** ⏳
- 落点：`apps/host/src/session-index.ts`（+例外文档追加登记一行）。
- 设计：锁文件 `session-index.json.lock`（`open wx` 独占创建 + 写 pid+时间戳）；持有者 pid 存活且未超时→等待重试（上限 2s）；持有者死亡/超时→抢占。与 host_lease 同一套「pid 存活检查」模式，零新依赖。锁内完成 read-modify-write 全程。
- 验收：并发单测（两个进程/两个 worker 循环 upsert 各 100 条 → 200 条全在）；M7。

**P2-2 双活写保护测试补全** ⏳
- 现状：host 级「前持有者存活 → 拒绝」单测**已有**（`宿主进程 N3-1` 用例，2026-10-26 随批次验证 20 passed）。
- 落点：`apps/host/test/session.test.ts`（补分支）、`apps/desktop/test/e2e/`（双窗口同会话）。
- 设计：补「持有者 pid 死亡 → 接管、epoch+1」分支单测与「requestId 复用续写已有文件」路径的 lease 断言；E2E：窗口 A 打开会话 → 窗口 B 打开同一会话 → B 收到「正在其他窗口使用」文案（依赖 P0-2 的 lease 文案），A 继续收流。
- 验收：M7。

### P3 分组语义对齐 + 功能增强

**P3-1 「任务/未归类」创建语义（对齐原型 v23）** ⏳
- 设计：侧栏 `selected` 增加 `inbox` 目标——点击「任务」标题=选中未归类；此时新建的会话在索引中记 `ungrouped: true`（`workspaceKey` 仍存真实 cwd，供信任/恢复用），列表合并时 `ungrouped` 条目进「任务」组。无任何工作区时新建默认 `ungrouped`。
- 落点：`host-protocol.ts`（`SessionCreateParams` 加可选 `ungrouped`——例外文档追加登记）、`server.ts`、`session-index.ts`（可选字段）、`DesktopSidebar.tsx`。
- 验收：E2E：点任务标题→新建→会话出现在「任务」组；重启后仍在。

**P3-2 归属单一权威化** ⏳
- 设计：host 索引为唯一归属权威（reconcile 已回填 workspaceKey）；renderer localStorage 降级为纯离线兜底（连接失败时才用），`useSidebarSessions` 的三向合并简化为「索引优先 + localStorage 补缺」。
- 验收：单测：索引与 localStorage 冲突时以索引为准。

**P3-3 索引搜索/分页** ⏳（P1-1 落地后成本极低）
- `sessions/list` 支持 `query`（标题/预览子串，host 侧过滤）与 `offset/limit`；侧栏搜索从「拉全量本地过滤」切到 RPC 过滤。

**P3-4 回收站保留期** ⏳
- 默认 30 天自动清理（可配 0=永不过期，保持现约束的保守默认需产品确认）；清理走现有 reconcile 周期 + `sessions/changed` 广播。

**P3-5 子会话 parentId** ⏳
- 索引加可选 `parentId`；subagent/派生会话在工作区树内缩进显示；CLI 侧 `sessions` 不变。

**P3-6 多会话并行（远期）** ⏳
- host「每窗口一个活动会话」→ 支持后台会话（每会话独立 host 进程已具备）；侧栏显示运行中状态点。规模大，待 P0–P2 稳定后单独立项（更新本文追加条目）。

### P4 原型功能补齐（模块 F 对账产生，会话线 P0–P2 之后进行）

按「巩固已有能力 > 新接线 > 纯 UI 打磨」排序；每项以模块 F 编号溯源。

**P4-1 Composer 能力面板（F12）** ⏳
上下文容量环（已用/总容量、缓存命中率、额度）+ 模型/思考强度选择（Ctrl+T 循环）。依赖 host usage/额度数据 RPC（部分已有 `/cost` 语义，需桌面接线）。

**P4-2 运行态补齐（F16）** ⏳
额度错误内联 banner（重置额度/反馈）、暂停点「继续」按钮、右上浮动进度卡（步骤 `2/5` + 子智能体卡，浮动不占栏）。

**P4-3 菜单补齐（F4/F5）** ⏳
任务 `...`：导出（复用 CLI JSONL 导出语义）、复制 ID；工作区 `...`：在编辑器中打开、归档工作区（只影响组织，不动目录/会话）。

**P4-4 context 浮动抽屉（F7/F18）** ⏳
常驻 SidePane 改为 400px 浮动抽屉（四周 12px 内缩、圆角阴影），关闭回到 780px 阅读宽度；≥1360/1180–1359/<1180 三档响应式行为一并核对。

**P4-5 设置子页渐进开放（F14）** ⏳
按原型分组补：常规/浏览器/快捷键/使用统计/归档（数据已有 host 来源）优先；记忆/子智能体/插件/MCP/技能/命令/钩子为 CLI 已有能力的桌面接线，量大，按需分批。provider 预设网格补齐添加供应商流程。

**P4-6 快捷键与令牌收口（F17/F19）** ⏳
⌘, 绑定设置（⌘T 随 P4-1）；桌面样式收敛到 `@kcode/design` 单一来源，删 `styles.css` 重复 token。

**P4-7 新功能线占位（F20/F21/F22，不属优化范围）** ⏳
自动化页 / 插件市场（本地管理优先）/ 终端+面板+帮助菜单。D3 冻结约束下需独立例外登记后立项；立项时本文仅追加占位行，详细方案走各自设计文档。

## 4. 执行顺序与依赖

```text
P0-1 提交 → P0-2 + P0-3（同批，创建链路统一改造）
        → P1-1 → P1-2 → P1-3（指标先行验证 P1-1 效果）
        → P2-1 → P2-2（P2-2 依赖 P0-2 的 lease 文案）
        → P3-1 → P3-2 → P3-3/3-4/3-5（可并行）→ P3-6 立项
        → P4-1 → P4-2 → P4-3/4-4/4-6（可并行）→ P4-5 → P4-7 按例外另行立项
```

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 例外文档约束（不改会话文件格式/CLI 行为） | 全部改动落在 host 索引/RPC 可选字段/renderer；P3-1/P2-1 动协议或索引字段时先追加例外登记 |
| 头部读取丢失 turns 精度 | turns 仅用于显示与「有内容」判断；精确计数保留在 CLI `listSessions` 原实现 |
| 缓存导致列表陈旧 | mtime+size 双键失效；fault 注入 E2E 覆盖「外部进程写入→缓存失效→列表更新」 |
| 跨进程锁死锁 | 超时抢占 + pid 存活检查；锁获取失败降级为直接写（最坏退回现状） |
| 行为变更影响既有 E2E | 每项先跑 desktop E2E 全量；护栏类变更同步更新断言 |

## 6. 状态台账

| 条目 | 状态 | 完成证据（测试/入口） |
|---|---|---|
| P0-1 收口当前批次 | ✅ 2026-10-26 | host 单测 20 passed + desktop E2E 7 passed（含 concurrency/crash-recovery/create-fault），已提交 |
| P0-2 失败可见可重试 | ✅ 2026-10-26 | E2E `create-failure.spec`（注入失败→卡片→重试恢复）+ `switch-guards` 单测 3 条；全量 E2E 9 passed |
| P0-3 忙碌护栏 | ✅ 2026-10-26 | E2E busy 拦截（本地挂起服务器方案）；desktop-v2 修正空闲信号后全绿（`.composer-send` 忙碌时也渲染，空闲判据=stop 消失） |
| P1-1 增量缓存 | ✅ 2026-10-26 | `session-summaries.test` 4 条（含未变零重读断言）；host/desktop 单测 28 passed + E2E 9 passed；M1 的 O(变化文件) 已落地，压测数字待 P1-3 |
| P1-2 renderer 节流 | ✅ 2026-10-26 | `sessions-signature.test` 3 条；单测 31 passed + E2E 9 passed；轮询无变化零 setState、信号 200ms 合并、events.filter 移出渲染（M5 逻辑闭环，运行时断言随 P1-3） |
| P1-3 压测指标 | ⏳ | CI |
| P2-1 索引跨进程锁 | ⏳ | 并发单测 |
| P2-2 双活测试 | ⏳ | lease 单测 + 双窗口 E2E |
| P3-1 未归类语义 | ⏳ | E2E |
| P3-2 归属单一权威 | ⏳ | 单测 |
| P3-3 搜索/分页 | ⏳ | 单测 |
| P3-4 回收站保留期 | ⏳ | 单测 |
| P3-5 parentId | ⏳ | 单测 |
| P3-6 多会话并行 | ⏳ 远期 | — |
| P4-1 Composer 能力面板 | ⏳ | E2E |
| P4-2 运行态补齐 | ⏳ | E2E |
| P4-3 菜单补齐 | ⏳ | E2E |
| P4-4 context 浮动抽屉 | ⏳ | E2E + 三档宽度手测 |
| P4-5 设置子页 | ⏳ | E2E |
| P4-6 快捷键/令牌 | ⏳ | 单测 + 视觉核对 |
| P4-7 新功能线 | ⏳ 占位 | 例外登记 |

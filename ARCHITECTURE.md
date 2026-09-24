# kcode（快码）架构设计文档

> **版本** v1.4 ｜ **日期** 2026-09-24 ｜ **状态** 定稿（P0 入库文档）
> **定位**：对标 ZCode 的全功能本地优先 AI 编程 Agent；差异化 = 插件市场 + 账户体系 + 远程操控电脑对话。
> **名称**：kcode / 快码（K = 快/开 双关）。npm scope：`@kcode`，配置目录 `~/.kcode/`，域名 `kcode.dev`（待注册）。
> **v1.1 变更**：六处信任边界安全修订；ADR-5 改判（自托管 IdP）并新增 ADR-10/11/12；新增 §12 企业就绪达标线。明细见 §13 变更记录。
> **v1.2 变更**：新增 §4.4 完整仓库目录树；apps/web 拆为 web（控制台）+ market（市场）分源，应用数 3→4。明细见 §13 变更记录。
> **v1.3 变更**：新增 ADR-13 命名决策（保留 kcode，备选 tcode）与 §11.C 品牌锁定清单。明细见 §13 变更记录。
> **v1.4 变更**：默认形态切换为 Claude Code 同款单进程（引擎抽入 `packages/session`，CLI 内嵌组装）；`apps/daemon` 与 `contracts/localapi` 本地 API 协议**完全删除**。明细见 §13 变更记录。

---

## 0. 一页总结

| 项 | 结论 |
|---|---|
| 语言 | TypeScript 全栈（Node.js 22 LTS，ESM，strict） |
| 形态 | **单进程 CLI（Claude Code 同款）** + 云端单体（中继/账户/市场）；daemon 已剔除 |
| 本地通道 | 进程内组装（无 IPC）；多端接入（P4 web 控制台）届时再定 |
| 认证 | 自托管 IdP（Zitadel/Logto）承载 Device Flow，不自研（ADR-5，v1.1 改判） |
| 更新/签名 | 更新链 TUF 角色分离（Ed25519）+ 插件签名 Sigstore keyless（ADR-11） |
| 扩展协议 | MCP（工具层）+ Agent Skills/SKILL.md（技能层）+ 插件包（分发层，ZCode 同构格式） |
| 核心纪律 | core 零 IO（接口注入）；contracts 除 zod 外零运行时依赖；依赖单向（引擎层 ← 能力层 ← 组合层反向禁止） |
| 起步规模 | **8 个物理包 + 3 个应用**起步（cli / web 控制台 / market 市场分源），17 个逻辑模块按边界成熟度逐步拆包；完整目录树见 §4.4 |
| 工期基线 | 3 人团队 10 个月完成 ZCode 全量对标（P0–P6）；v1.1 安全修订 +3–4 周按阶段摊入 |
| 产物 | 对外只有三个：`@kcode/cli`（npm）、插件包、server Docker 镜像（web/market 随其部署）；内部包永远 `workspace:*` 不发布 |

---

## 1. 产品定位与功能对标

### 1.1 功能矩阵（对标 ZCode，九域）

| 域 | 功能 |
|---|---|
| A 核心循环 | 流式输出、并行工具调用、后台任务、子 agent（含 agent 间消息）、Plan 模式、结构化提问、Todo |
| B 工具链 | read/write/edit、grep+glob（捆绑 ripgrep）、bash（超时/后台/会话级 shell 状态）、图片/视频/网页多模态 |
| C 上下文工程 | 自动压缩、SKILL.md 渐进加载+自动触发、AGENTS.md 记忆、会话 resume/跨会话读取 |
| D 扩展系统 | MCP、Skills、斜杠命令、Hooks（事件+模板变量）、插件+插件市场 |
| E 权限沙箱 | 权限模式、工具级 allow/ask/deny、命令沙箱、可信项目 |
| F 多端 | CLI、Web/手机远程对话（经云端中继） |
| G 自动化 | cron 定时任务（持久化、workspace 作用域、maxRuns 等完整语义）、代码审查 |
| H 电脑控制 | computer-use、browser-use、web search/fetch（fetch 走小模型摘要） |
| I 账户运营 | 登录、用量、云同步（密文）、遥测（opt-in） |

**明确不做（第一版）**：云 VM runner、GitHub @mention 集成、多候选实现生成、IDE 扩展、进程内插件系统、向量数据库、CRDT 多人协同、K8s。

### 1.2 差异化

ZCode 对标的"表格式"能力是入场券；商业化差异在：**插件市场（第一天兼容 MCP + SKILL.md 生态）、账户与用量体系、云端中继带来的多端远程对话**。这三项全部在 P4 闭环。
安全侧差异化（v1.1 新增）：**key 受众绑定、TUF 更新链、epoch 撤销、Sigstore 插件签名**为同类产品少有，可进官网安全页。

---

## 2. 总体架构

### 2.1 架构图

> **v1.4 已作废**：下图为 P3 的 daemon 架构；现默认形态是单进程 CLI（引擎内嵌、无 IPC），见 §9 执行进度与 docs/roadmap-c.md。云端单体（relay/账户/市场）仍为 P4 目标。

```text
   CLI(薄壳) ─┐                        ┌─ Web(Next.js: 控制台/远程对话 + 市场分源)
              │ UDS/named pipe（token） │
   desktop(后)├──────► apps/daemon ────┤
              │        （本地大脑）      │  出站 WSS（E2E 密文）
              │                        ▼
              │              ┌── 云端单体 services/server ──┐
              │              │  relay  ：WSS 中继(密文透传)  │
              │              │  auth   ：IdP 托管 Device Flow│
              │              │  registry：插件市场 API        │
              │              │  usage  ：计量接收/账单        │
              │              │  (IdP + Postgres + Redis + R2)│
              │              └───────────────────────────────┘
              │
   daemon 内部：core loop ◄─ context 组装 ◄─ {tools, mcp, skills, hooks,
                 permissions, scheduler, session, memory, plugins, transport,
                 usage, telemetry}   （SQLite 由 daemon 统一开库注入）
```

### 2.2 关键架构决策（ADR）

| # | 决策 | 理由与代价 |
|---|---|---|
| ADR-1 | TS 单语言，不自研 loop 也不 fork | ZCode 逆向实证同路线（@zcode/core 等 workspace 包）；fork 会在账户/市场渗透核心时反噬 |
| ADR-2 | 本地 daemon + 出站 WSS 中继（Tailscale 式） | 免 NAT/端口；本地是 source of truth；代价 = 必须做 E2E 与版本协商 |
| ADR-3 | 扩展层全走开放标准（MCP + SKILL.md + 插件三件套） | 市场第一天兼容既有生态；逆向 ZCode 证明该格式可承载全部功能 |
| ADR-4 | core headless、不假设运行环境 | 第一版只跑 daemon，但为云 runner（未来）保留容器化可能 |
| ADR-5 | **认证用自托管 IdP（Zitadel 或 Logto），不自研**（v1.1 改判） | 自研 auth 的边角路径（密码重置/账号恢复/令牌吊销/防爆破）是漏洞长尾，企业安全审查难通过；代价 = compose 多一个容器；未来 SSO/SAML/SCIM 为配置项。原"Fastify+pg 自建"方案作废 |
| ADR-6 | 7 包起步、逻辑 17 模块 | 3 人团队维护 17 个物理包是负资产；P3 后按边界成熟度拆包 |
| ADR-7 | 会话 JSONL append-only + `v` 版本字段 | 天然回放做 eval 夹具与售后排查；schema 演进可迁移 |
| ADR-8 | 多设备强约束：一个会话同一时刻仅一个活跃设备 | 避免 CRDT/合并复杂度；切换 = 拉快照 + 锁（租约制，见 §5.3） |
| ADR-9 | 身份与模型来源解耦：登录（网关）/ BYOK（sk）/ OpenAI 兼容端点三模式并存，不登录可完整本地使用 | 零门槛获客（先 BYOK 跑起来）+ 订阅计费留路径；API key 永不入库、不上云 |
| ADR-10 | **daemon 本地通道用 UDS/named pipe，TCP 回环兜底** | 访问控制即文件权限/每用户 ACL，rebinding、跨站 WS 等网络面攻击结构性消失（Docker 同款）；兜底时启用 Host/Origin 校验+token 三件套 |
| ADR-11 | **更新链 TUF 角色分离；插件签名 Sigstore keyless + registry 副签** | CI 在线钥匙泄露可由离线 root 重授权轮换、无需发版；发布者零密钥管理，Rekor 透明日志可审计；离线安装走 registry 副签验证 |
| ADR-12 | **E2E 会话密钥 epoch 模型 + 会话内 HKDF 逐消息 ratchet** | 设备撤销即时生效 = 换新 DEK 而非重包（重包对已解包设备无效）；MLS（RFC 9420）浏览器端不成熟，列远期评估；诚实边界：无后向保密，见 §5.6 |
| ADR-13 | **产品名保留 kcode（快码）；唯一备选 tcode**（v1.3） | 2026-09-17 npm 实测：字母+code 模式仅 kcode/tcode/qcode 可用（qcode 有二维码歧义排除），其余均被占用；K 为一线 logo 字母（笔画少、16px 仍锐利，Kotlin 同款路线），快/开双关已成立；tcode 有 SAP t-code 联想且中文双关弱，仅作备选。品牌锁定动作见 §11.C |

---

## 3. 技术底座（定版清单）

| 层 | 选型 | 备注 |
|---|---|---|
| 语言/运行时 | TypeScript 5 strict + Node.js 22 LTS | ESM 输出；不用 Bun 做运行时 |
| Monorepo | pnpm workspaces + Turborepo | |
| 构建 | tsup（esbuild 内核） | CLI 单文件 bundle，`npm i -g @kcode/cli`；Node SEA 单二进制留到 P3 后 |
| 模型接入 | Vercel AI SDK + providers 配置层 | 三模式：kcode 网关（登录）/ BYOK（sk 多厂商）/ OpenAI 兼容私有端点；**不登录可完整使用** |
| 插件协议 | `@modelcontextprotocol/sdk` 官方 TS SDK | 工具名空间 `mcp__<server>__<tool>` |
| CLI TUI | Ink + React | 要求 Windows Terminal（老 conhost 不支持） |
| 本地存储 | better-sqlite3（WAL；重查询进 worker）+ 会话 JSONL | 同步 API 会阻塞事件循环 → worker 化；Windows 分发需 prebuilt 策略（免 node-gyp） |
| 加密 | libsodium-wrappers + node:crypto | 信封加密（epoch 模型）、计量签名、keychain 降级加密 |
| 网络 | ws（客户端/服务端同库） | 断线重连+离线队列自写；本地通道 UDS/named pipe 由 Node 原生支持 |
| Schema | zod | contracts 地基 |
| 日志 | pino | OpenTelemetry 后加（GA 前仅基础 metrics，见 §12） |
| 测试 | vitest | 三层金字塔见 §8.2 |
| Lint | oxlint + prettier | |
| 认证 | **自托管 IdP：Zitadel 或 LogTo**（OAuth 2.0 Device Flow + JWT access/refresh 轮换） | ADR-5（v1.1 改判）；MFA/社交登录开箱 |
| 更新与签名 | **Ed25519（TUF 角色分离：离线 root + 在线 release + timestamp）+ Sigstore（cosign / npm provenance）** | ADR-11 |
| 云端 | Fastify + @fastify/websocket + Drizzle ORM + PostgreSQL + Redis + BullMQ | 单体内部四模块硬隔离；relay 多实例时走 Redis 路由 |
| 对象存储 | S3 兼容（Cloudflare R2） | 插件包分发，零出口流量费 |
| Web | Next.js + Tailwind + shadcn/ui | 控制台与市场**分源**部署（§5.6） |
| 部署 | 单 VM docker-compose（app + idp + pg + redis） | 付费用户上千前不上 K8s |
| 捆绑二进制 | ripgrep（@vscode/ripgrep 方式） | 搜索性能底线 |

**分发渠道**：npm（主，开 Sigstore provenance）、Homebrew、scoop/winget、安装脚本（自带验签）。

---

## 4. 仓库结构与依赖模型

### 4.1 物理包（P0 建立）与逻辑模块映射

| 物理包 | 内含逻辑模块（目录即最终拆包形态） |
|---|---|
| `packages/contracts` | 全部共享 zod schema：会话事件、Tool/Provider 接口、hook 事件、relay 协议消息、本地 API 消息、UsageEvent、插件清单 `.kcode-plugin`（name/marketplace/version 路径正则）、**密钥层级（epoch 模型）**、**ProviderConfig 双作用域（user/project 分 schema + key 受众绑定）**、**TUF 更新 manifest** |
| `packages/shared` | 纯工具函数，零外部依赖（zod 除外） |
| `packages/core` | core（loop/工具管线/事件总线/子 agent）+ context（组装/预算/压缩调度） |
| `packages/tools` | tools（内置工具+跨平台 shell 抽象）+ mcp（ToolProvider） |
| `packages/runtime` | session（JSONL/压缩器/回放器）+ memory + scheduler（cron） |
| `packages/extensions` | skills（解析/渐进加载/统一发现）+ hooks + plugins（安装/seed 锁定/**签名验证**）+ permissions |
| `packages/platform` | transport（WSS/E2E/配对/版本协商/更新链）+ auth（IdP 客户端/keychain）+ **providers（模型接入配置/路由/凭证管理/受众校验）** + usage + telemetry |

应用与服务：

| 位置 | 职责 |
|---|---|
| `apps/cli` | **单进程组装点**：内嵌组装引擎（`@kcode/session`）、Ink 渲染与输入；会话落 JSONL、`--resume` 续接 |
| `apps/web` | Next.js **控制台**：仪表盘 + 远程对话（WebCrypto 参与解密，non-extractable 私钥）——持有设备私钥的 origin |
| `apps/market` | Next.js **市场**：搜索/详情/发布者页，与 web **分源部署**，UGC 只在 sandboxed iframe 渲染（§5.6）——v1.2 由分源决策独立成应用 |
| `services/server` | Fastify 单体：relay / auth（IdP 反代）/ registry / usage 四模块硬隔离 |
| `plugins-official/` | 官方插件仓库：code-review、skill-creator、computer-use（P6）、browser-use（P6） |
| `evals/` | workspace 包：会话 JSONL 夹具 + 评分脚本 |

### 4.2 分层依赖模型（用工具强制）

```text
组合层  apps/cli + packages/session ──► （唯一允许 import 一切的地方）
引擎层  core + context ──► 定义 Provider 接口，依赖 contracts
能力层  tools/runtime/extensions/platform ──► 实现 engine 接口
底座    contracts / shared（零依赖）
```

规则（CI 用 dependency-cruiser 锁死）：

1. **能力层之间禁止互引**（tools 不能 import runtime）；
2. **任何包不得反向依赖引擎层/组合层**；
3. 引擎层首选通过 contracts 中的接口消费能力层（DI 注入）；P0 期间允许引擎层直接引用能力层类型，但不得调用其 IO 实现；
4. `apps/web`、`apps/market` 只通过 relay 通信（P4），禁止直接 import packages（类型除外）。

### 4.3 插件包格式（ZCode 同构 + 签名强化）

```text
plugins-official/code-review/
├── package.json          # "@kcode/plugin-code-review"
├── .kcode-plugin         # 插件清单（schema 见 contracts）：
│                         #   { name, version, skills[], commands[], hooks[],
│                         #     mcp: [{name, transport, command|url}], permissions[] }
├── skills/code-review/SKILL.md
├── commands/  hooks/  scripts/
└── dist/mcp/server.js    # 若带 MCP server（独立进程，天然隔离）
```

清单 schema 硬约束（v1.1）：

- `name`/`marketplace`/`version` 一律匹配 `^[a-z0-9][a-z0-9-_.]{1,63}$`（禁 `..`、`/`、`\`、前导点）；拼接后 `path.resolve` 断言仍落在 cache 根内——防路径穿越；
- 插件注册的一切（hooks/工具/技能/命令）强制命名空间 `plugin:<name>::`，使 deny 规则可精确匹配。

安装后布局（照抄 ZCode 实测结构）：

```text
~/.kcode/cli/
├── plugins/cache/<marketplace>/<plugin>/<version>/   # 版本化缓存
│   └── .kcode-seed.json    # { hash, marketplace, plugin, version, sig }  ← ZCode 仅 hash，我们加签名
├── agents/sess_<id>/agent_<id>/     # 每会话子 agent 转录
├── exec/shell-startup/sess_<id>/    # 每会话独立 shell 状态（环境快照默认脱敏 token/key 模式）
├── artifacts/sess_<id>/
└── db/                              # SQLite（WAL）
```

### 4.4 完整仓库目录树（P0 脚手架基线，v1.2）

约定：每个包均含 `package.json`（`@kcode/<name>`，内部引用一律 `workspace:*`）、`tsconfig.json`（继承 `tsconfig.base.json`）、`tsup.config.ts`，树中省略；**包内一级目录 = 逻辑模块 = 未来拆包单元**（P3 后 7→17 拆包就是把这些目录提升为包，tsconfig paths 重指即可）；依赖方向由 `.dependency-cruiser.cjs` 按 §4.2 四条规则锁死。

```text
kcode/
├── package.json                     # 根：turbo run build / test / lint:deps
├── pnpm-workspace.yaml              # apps/* services/* packages/* plugins-official/* evals
├── turbo.json                       # typecheck → build → test 管道
├── tsconfig.base.json               # strict / ESM / paths 基座
├── .dependency-cruiser.cjs          # §4.2 依赖规则（CI 门禁）
├── oxlint.config.ts / .prettierrc
├── .github/workflows/ci.yml         # typecheck + vitest + depcruise；P4 起加 SBOM
├── deploy/
│   └── docker-compose.yml           # server + zitadel(IdP) + postgres + redis（§3 部署）
├── docs/
│   └── threat-model.md              # P0 交付：STRIDE + 六处信任边界图（§9）
│
├── packages/
│   ├── contracts/                   # ── 除 zod 外零运行时依赖（§0）──
│   │   └── src/
│   │       ├── index.ts
│   │       ├── session.ts           # JSONL 事件 schema（v:1）
│   │       ├── tool.ts              # Tool / ToolResult / 权限裁决接口
│   │       ├── provider.ts          # Provider 接口 + ProviderConfig 双作用域（§5.7）
│   │       ├── keyhierarchy.ts      # epoch 密钥 / 信封 / 设备授权表消息（§5.6.1）
│   │       ├── relay.ts             # 设备↔relay WSS 协议消息（P4）
│   │       ├── hooks.ts             # hook 事件 + 模板变量
│   │       ├── usage.ts             # UsageEvent（BYOK 假名化）
│   │       ├── plugin-manifest.ts   # .kcode-plugin（路径正则 + plugin:<name>:: 命名空间）
│   │       └── update.ts            # TUF root / release / timestamp manifest（§5.6.3）
│   ├── shared/
│   │   └── src/                     # 纯函数：路径 / ID / JSONL 追加写 / token 估算
│   ├── core/                        # ── 引擎层：定义接口，DI 消费能力层 ──
│   │   └── src/
│   │       ├── core/
│   │       │   ├── loop.ts          # 状态机：输入→组装→LLM→并行工具→回填→循环
│   │       │   ├── pipeline.ts      # permissions→pre_hooks→执行→post_hooks→审计
│   │       │   ├── events.ts        # 事件总线
│   │       │   └── subagent.ts      # 子 agent 编排 + 消息互通
│   │       └── context/
│   │           ├── assemble.ts      # cache 友好组装（前缀逐字节稳定，§5.2）
│   │           ├── budget.ts        # system/skills/history/tool-result 分区配额
│   │           └── compact.ts       # 压缩时机调度（摘要事件写回 session）
│   ├── tools/                       # ── 能力层：互引禁止 ──
│   │   └── src/
│   │       ├── tools/
│   │       │   ├── fs.ts / edit.ts / search.ts    # read/write/edit + 捆绑 rg 的 grep/glob
│   │       │   ├── shell/                          # 跨平台抽象（bash｜PowerShell→cmd）
│   │       │   └── multimodal.ts                   # 图片/视频/网页输入
│   │       └── mcp/
│   │           ├── provider.ts      # MCP ToolProvider → 统一 Tool 接口（§5.4）
│   │           └── process.ts       # MCP server 进程生命周期（--ignore-scripts 产物）
│   ├── runtime/
│   │   └── src/
│   │       ├── session/
│   │       │   ├── jsonl.ts         # append-only 事件流（v:1）
│   │       │   ├── compactor.ts     # 压缩写回
│   │       │   └── replayer.ts      # replay:true——hooks 不执行、工具用录制结果（§8.2）
│   │       ├── memory/              # 压缩记忆 → AGENTS.md → sqlite-vec（P4 后评估）
│   │       └── scheduler/           # cron 全语义 + automation 权限模式（§5.5）
│   ├── extensions/
│   │   └── src/
│   │       ├── skills/              # discover()（内置+插件+用户）/ 渐进加载 / 触发
│   │       ├── hooks/               # 事件分发 / stdin JSON / veto
│   │       ├── plugins/             # install（同意页）/ seed 锁定 / verify（Sigstore+副签）
│   │       └── permissions/          # allow/ask/deny + 预设模式 + automation
│   └── platform/
│       └── src/
│           ├── transport/
│           │   ├── wss.ts           # relay 长连：断线重连 + 离线队列
│           │   ├── pairing.ts       # 配对（需已授权设备批准，§5.6.1）
│           │   ├── device-acl.ts    # 每会话设备授权表（撤销联动）
│           │   ├── version.ts       # 协商 + 带签名最低版本声明
│           │   ├── e2e/             # epoch.ts / envelope.ts / ratchet.ts / recovery.ts
│           │   └── update/          # tuf.ts（验签）/ apply.ts（原子替换+健康检查回滚）
│           ├── auth/                # idp-device-flow.ts / keychain.ts（DPAPI·Keychain·降级）
│           ├── providers/           # route.ts（AI SDK）/ credentials.ts（受众校验）/ capabilities.ts
│           ├── usage/               # meter.ts（签名）/ report.ts（批量上报+假名化）
│           └── telemetry/           # logger.ts（pino）/ optin.ts
│
├── apps/
│   ├── cli/                         # 单进程组装点：唯一允许 import 一切
│   │   └── src/
│   │       ├── main.tsx             # 入口：bootstrap 组装 Runtime → KcodeApp
│   │       ├── bootstrap.ts         # 配置 → keychain → providers 路由（受众绑定）
│   │       ├── session.ts           # createSession：进程内 composeSession 句柄
│   │       └── tui/                 # Ink 渲染与输入（App.tsx + components/）
│   ├── web/                         # 控制台（持有设备私钥的 origin）
│   │   └── src/
│   │       ├── app/                 # (dashboard)/ 仪表盘 + chat/ 远程对话
│   │       └── lib/crypto/          # device-key.ts（non-extractable）/ unlock.ts（passphrase 包裹）
│   └── market/                      # 市场（与 web 分源部署，v1.2 独立成应用）
│       └── src/
│           ├── app/                 # search / plugin/[id] / publisher/[id]
│           └── components/plugin-readme/   # sandboxed iframe + CSP 渲染 UGC（§5.6）
│
├── services/server/                 # Fastify 单体：四模块硬隔离
│   └── src/
│       ├── index.ts                 # 装配 + 每设备限速
│       ├── relay/                   # gateway.ts（WSS 密文透传）/ sessions.ts（租约 TTL，§5.3）
│       ├── auth/                    # idp.ts（IdP 反代）/ devices.ts（设备公钥注册）
│       ├── registry/                # api.ts / verify.ts（Sigstore）/ countersign.ts / scan.ts（扫描门）/ crl.ts
│       ├── usage/                   # ingest.ts / billing/（BullMQ worker）
│       └── shared/                  # db/（drizzle schema+migrations）/ redis.ts / r2.ts / config.ts
│
├── plugins-official/
│   ├── code-review/  skill-creator/         # 结构见 §4.3
│   └── computer-use/ browser-use/           # P6
└── evals/
    ├── fixtures/                    # JSONL 会话夹具（replay 安全模式驱动）
    └── score/                       # 通过率 / token 成本评分脚本（CI 跑）
```

读法与对应关系：

1. **包内一级目录 = 逻辑模块**（core、context、tools、mcp、skills、hooks、plugins、permissions、session、memory、scheduler、transport、auth、providers、usage、telemetry 等）——P3 后"物理拆包 7→17"即目录提升为包，import 路径经 tsconfig paths 重指不变；
2. **web 与 market 是两个应用、两个 origin**：§5.6 分源决策的落地——market 渲染不可信 UGC，永远不加载设备私钥相关代码；两边 shadcn/ui 组件各自拷贝，不为共享 UI 增包；
3. **部署对应**：`deploy/docker-compose.yml` = §3 的 server + IdP + pg + redis；web/market 各自独立部署（market 可上 CDN 静态化）；
4. **可信项目门控（§5.4）与 automation 模式（§5.5）落在 extensions/permissions**，组合层只做注入，不自带策略。

---

## 5. 关键子系统设计

### 5.1 Agent Core

**Loop 状态机**：`用户输入 → 上下文组装 → LLM(流式) → 工具调用(并行) → 结果回填 → 循环/结束`。每步产生 JSONL 事件。

**工具调用管线（顺序定死）**：

```text
tool_call ─► permissions（纯本地裁决，快） ─► pre_tool_use hooks（可 veto/改参）
         ─► 执行（内置工具 或 MCP server 进程） ─► post_tool_use hooks ─► 结果+审计事件
```

- 并行调用：一轮多个只读工具并发执行；
- 子 agent：`general-purpose / explore / judge` 等类型，独立上下文用完即弃，仅结论回流主会话；支持后台运行与消息互通；
- 后台任务：`run_in_background` + 任务表 + 完成通知。

### 5.2 上下文引擎（cache 友好是第一约束）

组装顺序（**前缀逐字节稳定**以命中 prompt cache，省 50–90% 输入成本）：

```text
[稳定区] system prompt → 内置工具/技能描述 → 历史消息(含已完成工具结果)
[动态区] 本轮新工具结果 / 注入的技能正文
```

- token 预算管理：system/skills/history/tool-result 各自配额，超限触发压缩；
- 压缩：由 context 决定时机、session 提供历史并写回摘要事件（摘要进 JSONL，回放可见）；
- 技能渐进加载：先只注入元数据，命中后按需展开正文。

### 5.3 会话与记忆

- JSONL 事件流首字段 `v: 1`；支持 resume/分支；跨会话读取按 `sess_id` 授权拉取；
- SQLite 由 **组合层统一开库注入**（WAL + worker），各模块不自管连接；
- 记忆三层：会话内上下文（压缩）→ 项目/用户级 markdown（AGENTS.md 同构）→ 长期记忆（可选 sqlite-vec，P4 后评估）；
- 多设备：会话密文上云镜像，**单活跃设备锁定**（ADR-8）。锁为**带 TTL 的租约**：60s 过期、15s 心跳经 relay 续租；租约丢失一方自动转只读；不合并、快照覆盖——持锁设备崩溃不再死锁。

### 5.4 扩展系统

- **统一 Tool 抽象**：内置工具与 MCP 工具实现同一接口（permissions/hooks/审计只写一遍）；
- **skills 单一发现入口**：内置目录 + 插件目录 + 用户目录统一 `discover()`，plugins 只落盘不解析；
- **项目级自动加载物一律经"可信项目"门控**（v1.1）：项目 hooks、项目技能、项目 MCP、项目配置四类，首次打开未知项目时展示"将自动运行什么"（hooks 命令行、MCP 启动命令/URL）并请求信任；headless/CI 模式默认忽略项目级扩展——防 clone 恶意仓库即 RCE；
- **技能按提示注入面处理**（v1.1）：第三方技能默认手动调用，自动触发需逐插件显式开启；官方/审核通过的可默认自动；
- 斜杠命令：用户/项目作用域 + 优先级合并；hooks：`session_start / pre_tool_use / post_tool_use / stop` 等，stdin JSON、退出码/JSON 决定放行或拦截，支持模板变量。

### 5.5 调度器（ZCode 语义完整对齐）

| 能力 | 语义 |
|---|---|
| cron | 5 字段，本地时区 |
| 一次性 | `delayMinutes` 相对当前时刻，不落 cron |
| 周期 | `intervalUnit`(minute…yearly) + `interval`(1–200) |
| 有限次数 | `maxRuns`（仅一次性/有限任务） |
| 持久化 | SQLite，workspace 作用域，重启不丢 |
| 权限 | **`automation` 权限模式**（v1.1）：任务创建时声明工具/命令 allowlist；headless 运行中 ask 一律降级为 deny+记录+推送通知 |

到期触发 headless 会话（复用 core），结果走通知（CLI 内 + relay 推送）。

### 5.6 传输、本地通道与更新链

#### 5.6.1 E2E 密钥层级（epoch 模型，contracts P0 定型）

- **设备密钥对**：每台设备（本地 CLI 电脑、浏览器 session、手机）登录时生成，云端只存公钥；新设备接入需**已授权设备批准**（WhatsApp 式）+ 配对码——防钓鱼配对；
- **会话 DEK 按 epoch 管理**：每会话每 epoch 一把内容密钥，用当前全部授权设备的公钥各包一份（信封加密）→ 浏览器/手机可解密，relay 永远只见密文；消息内再加一层 **HKDF 逐消息 ratchet**（每条消息密钥从前一条派生）取得消息级前向保密；
- **epoch 自动轮换**：每 24h 或每 N 条消息，不等撤销，压缩泄露窗口；
- **撤销 = epoch+1**（v1.1 修正）：生成新 DEK 只包给剩余设备，后续消息全部换钥；同时 relay 侧**每会话设备授权表**拒绝被撤销设备接入（设备连接用设备私钥签名握手认证，纵深防御）。注意：仅重包旧 DEK 信封对已解包过 DEK 的设备**无效**——这是 v1.0 方案错误；
- **恢复码**：初始配对时生成打印，作为无设备时的根信任，用于重包 DEK——否则唯一设备丢失会把用户永久锁死在云同步外；
- **诚实边界**：无后向保密——被攻陷设备可永久读取其攻陷前已解密的内容；高风险用户可选"全量重加密"（一台活跃设备本地解开整会话、换新 DEK 重传）。relay 零知识指**内容**，元数据（路由/时间/规模）仍可见。

#### 5.6.2 本地通道（ADR-10）

> **v1.4 已作废**：daemon 与本地 API 已删除（单进程内嵌组装，无 IPC）。以下为 P3 历史设计留档；P4 多端接入时重新评估。

- **优先 UDS**（`~/.kcode/daemon.sock`，macOS/Linux）**/ Windows named pipe**（`\\.\pipe\kcode`，每用户 ACL）：访问控制即文件权限，无端口即无 rebinding/跨站 WS 攻击面，多用户机器上其他账户不可连；
- **TCP 回环仅兜底**：绑定 127.0.0.1（禁止 0.0.0.0），校验 `Host` ∈ localhost 变体（杀 DNS rebinding），WS 升级校验 `Origin` 白名单（非浏览器客户端无 Origin 则必须持 token）；
- **token 发放**：CLI spawn daemon 时经继承 stdio 管道传递；attach 场景写 `~/.kcode/daemon.token`（600/ACL），daemon 启动自检文件权限，发现过宽立即轮换 token 并告警；
- **纪律**：keychain 读取只发生在 daemon 进程内，本地 API 不暴露任何"读密钥"端点，CLI 永不接触 key 明文。

#### 5.6.3 版本协商与更新链（ADR-11，TUF 角色分离）

- **角色分离**：离线 **root key**（pin 进客户端，仅签"合法钥匙表"，几乎不用）→ CI 在线 **release key**（签每次发版 manifest：`version / minSupported / artifacts[{platform,url,sha256}]`）→ **timestamp** 角色（短时效清单防回滚攻击）；
- CI 钥匙泄露的恢复：离线 root 重签钥匙表即作废旧 release key，**无需发客户端版本**；
- 客户端：验签 → 下载 → 校验 sha256 → **原子替换** → 首启健康检查失败自动回滚；
- "强制升级"信号：relay 下发**带签名的最低版本声明**（客户端用 pinned root 验证）后才触发，杜绝中间人/仿冒页面伪造"必须升级"钓鱼；
- npm 渠道开 GitHub Actions Sigstore provenance；安装脚本自带验签逻辑。

### 5.7 账户、模型接入与计量

**身份与模型来源解耦（ADR-9）**：kcode 账户只管市场/同步/订阅；模型从哪来是独立配置——**不登录也能完整使用本地功能（BYOK）**，零门槛获客。

**模型接入三模式（providers 模块统一路由到 Vercel AI SDK）**：

| 模式 | 说明 | 计费 |
|---|---|---|
| 网关（登录） | 订阅后模型流量走 kcode 网关，官方供给 | 订阅额度 |
| BYOK（sk） | 自配厂商 API Key（GLM/OpenAI/Anthropic/DeepSeek…） | 用户自负，kcode 仅本地统计 |
| OpenAI 兼容端点 | baseURL + key 指向 one-api/中转/Ollama/vLLM 私有部署 | 同 BYOK |

配置示例（`~/.kcode/config.json`，schema 在 contracts）：

```jsonc
{
  "models": {
    "default": "glm-4.7",
    "providers": {
      "kcode":    { "type": "gateway" },                                   // 登录即用
      "openai":   { "type": "openai", "keyRef": "keychain://openai" },
      "deepseek": { "type": "openai-compatible", "baseURL": "https://api.deepseek.com/v1", "keyRef": "keychain://deepseek" },
      "local":    { "type": "openai-compatible", "baseURL": "http://127.0.0.1:11434/v1" }  // Ollama
    }
  }
}
```

规则（v1.1 重写）：

- **双作用域 schema（防 key 外泄，第一层）**：`providers`（含 `type`/`baseURL`/`keyRef`）**只存在于用户级配置**；项目级 `.kcode/config.json` 是独立小 schema，仅可**按名引用**用户级已配置的 provider 设默认模型，出现 `providers` 字段即 parse error——恶意仓库改 baseURL 指向攻击者在 schema 层不可表达；
- **key 受众绑定（第二层，同类产品少有）**：keychain 条目同时存 key 与**允许端点列表（audiences）**；组合层每次调用前校验 `provider.baseURL ∈ keyEntry.audiences`，不匹配即硬失败并走交互式重新授权（`kcode config` 改端点同样触发）——用户配置被篡改或组合层 bug 均无法把 key 发往新端点；
- API key 永远只存 OS keychain（Windows **DPAPI** / macOS **Keychain**；两者皆不可用才降级为 passphrase 加密文件并显式告警——**禁止**自制机器 ID 派生密钥的假保护），config 只存 `keyRef`；BYOK 的 key 绝不上云；
- provider 声明/探测能力（tool calling、多模态、cache）；不支持 tool calling 的模型启动时明确降级提示（内置工具强依赖）；
- 每次调用模型可参数化（`model: "deepseek/chat"` 解析 → provider 路由），为未来按任务类型路由便宜模型留口；
- **登录**：OAuth Device Flow 由自托管 IdP 托管（ADR-5）；token 进 keychain（P0 加密文件+机器绑定，P3 接原生 Credential Manager/Keychain）；
- **计量与内容分通道**：LLM 调用产生 `UsageEvent { model, inputTokens, outputTokens, cachedTokens, priceTableVersion, sessionId }`，设备签名后批量上报；网关模式可作计费依据（保留可关联性用于计费），BYOK 模式仅本地统计/可选上报且 **sessionId 以 `HMAC(deviceKey, sessionId)` 假名替换**——防用量事件与服务端 relay 元数据（时间/规模）关联，实质削弱零知识承诺（R3 缓解）；
- 第一版商业形态 = **BYOK 免费用 + 市场/云同步需登录**；网关订阅作为 P5 后的商业升级项。

### 5.8 插件市场（registry）

API：搜索 / 详情 / 版本列表 / 发布（CLI `kcode plugin publish`）/ 下载统计。

供应链（v1.1 重写，按真实攻击面设计）：

- **发布者签名 = Sigstore keyless**：发布时用 GitHub OIDC 身份现场签发短时效证书签名（Rekor 透明日志可审计、可追责），发布者**零密钥管理**——没有丢钥匙/被盗号/身份纠纷的长尾；
- **registry 审核后附加平台副签**：作为离线安装场景的验证路径（Sigstore 验证需联网或缓存包含证明，副签兜底）；
- **发布时自动扫描门**（Socket/Phylum 式）：hooks 命令外联模式、install 脚本、技能文本注入特征；命中进人工审核队列；
- **安装/升级同意页**：渲染 manifest 摘要——注册的 hooks（含命令全文）、MCP 进程命令行/URL、技能触发词、申请的 permissions；升级时（seed 锁已强制显式）展示**版本间 diff**；
- **MCP 依赖安装一律 `--ignore-scripts`**：postinstall 即任意代码执行；构建步骤只允许 manifest 白名单显式命令；发布者提交 lockfile；
- **seed 锁定**：版本+hash，升级必须显式；
- **技能的定位从"纯文本=安全"改为"提示注入面"**：默认手动触发（§5.4），审核清单按行为红旗审技能内容；
- **吊销**：CRL 模式，安装与升级均检查；
- 第一版插件只允许三种形态：MCP server（独立进程）、SKILL.md、声明式 hooks——**不允许进程内代码插件**（不变）。

---

## 6. 跨平台要求（Windows / macOS）

| 项 | 方案 |
|---|---|
| Shell | 抽象层：macOS/Linux 用 bash；Windows 优先 PowerShell，fallback cmd |
| 路径 | 一律 `path.join`；显式处理 CRLF/LF |
| 凭证 | OS 凭证库（DPAPI/Keychain）；不可用时 passphrase 加密文件降级（§5.7） |
| 终端 | 文档声明需 Windows Terminal；Ink 兼容性以 WT 为准 |
| 文件监听 | chokidar |
| 命令沙箱 | **分层**（v1.1）：**默认层** = macOS seatbelt（profile 参考 codex 开源实现，含 network 限制）+ Windows **AppContainer**（默认不带网络 capability）+ 工作区外 **default-deny 写**；**加固层**（opt-in）= 检测到 Docker Desktop/WSL2 时命令在容器内执行，远程会话/computer-use 默认要求或强提示。威胁模型独立成文（P0）：防提示注入外泄/误操作，不防本地恶意软件/内核 |
| Kill switch | 全局 `kcode halt` + UI 停止按钮；远程 computer-use 不活动自动上锁 |

---

## 7. 安全模型（分层汇总）

| 层 | 机制 |
|---|---|
| 工具执行 | permissions（allow/ask/deny + 预设模式）→ hooks veto → 审计日志（append-only + 本地 hash 链） |
| 命令 | 分层沙箱（§6）+ 工作区外 default-deny 写；**可信项目门控覆盖项目 hooks/技能/MCP/配置四类** |
| 插件 | 进程外运行（MCP）+ `--ignore-scripts` 安装；技能按提示注入面处理（默认手动）；Sigstore keyless + registry 副签 + 扫描门 + seed 锁定 + CRL |
| 传输 | E2E epoch 信封加密 + 逐消息 ratchet（§5.6）；relay 零知识（内容）；新设备需已授权设备批准；撤销即时生效 |
| 本地 | 进程内组装（无 IPC，v1.4）；keychain 只在 CLI 进程内读取；P4 多端接入的通道届时再定 |
| 更新链 | TUF 角色分离签名 + 验签后原子替换 + 健康检查回滚 + 带签名的强制升级声明（§5.6） |
| 远程会话 | 默认收紧权限（只读工具默认放行，写/网络/电脑控制逐项确认）；全量审计 |
| 无人值守 | `automation` 权限模式（§5.5）：ask 降级为 deny+记录+通知 |
| 遥测 | 本地留存、opt-in 上报、上报内容可预览；BYOK 用量 sessionId 假名化 |

**已知边界（诚实声明，不宣称解决）**：① 提示注入——全行业未解，权限分级/技能手动触发/审计为缓解；② Windows 沙箱为分层缓解，非硬隔离；③ E2E 无后向保密（§5.6）；④ relay 可见元数据。对外安全页与销售话术不得超出此声明。

---

## 8. 可观测性与评估

### 8.1 遥测

pino 结构化日志 + 每 loop 的 trace 导出（消息/工具调用/token 数可导出为文件）。隐私立场：**本地留存、opt-in 上报**。

### 8.2 测试金字塔（evals 是迭代能力，不是可选项）

1. **单测**：loop 状态机，mock LLM；
2. **回放**：JSONL 会话夹具驱动 core 重放，断言工具序列与产出（进 CI）。**回放安全（v1.1）**：回放 harness 全局 `replay: true`——hooks 不执行、工具执行器替换为录制结果，CI 中真实命令/hooks 永不运行（防回放夹具本身成为 RCE 面）；
3. **eval**：30–50 个典型任务（代码审查/修 bug/跑工作流），对比通过率与 token 成本，改 prompt/换模型必跑。

---

## 9. 实施路线图（P0–P6，3 人 × 10 个月）

| 阶段 | 时间 | 交付 | 验收演示 |
|---|---|---|---|
| P0 地基 | 2 周+ | monorepo、contracts（JSONL/Tool/**密钥层级 epoch**/**ProviderConfig 双 schema+受众绑定**/**TUF manifest**/**.kcode-plugin 路径正则+命名空间**）、core 骨架（mock LLM）、evals 夹具启动、CI+依赖规则门禁、**威胁模型一页（STRIDE+信任边界图）** | 回放一段录制会话 |
| P1 单机 CLI | M1–2 | 工具链+捆绑 rg、流式 TUI、并行工具、权限 v1、**providers 多厂商接入（网关登录/sk/OpenAI 兼容/Ollama）+ 受众绑定校验**、Plan 模式/Todo/结构化提问、图片输入 | Win+Mac 真实仓库完成 10 个任务 |
| P2 上下文工程 | M3 | compaction、SKILL.md 加载+自动触发、AGENTS.md、resume/跨会话、cache 友好组装 | 长会话 token 曲线走平；eval 不退化 |
| P3 扩展+daemon | M4 | MCP、斜杠命令、hooks、插件装卸（含同意页+`--ignore-scripts`）、**apps/daemon 常驻+本地 API（UDS/named pipe）**、沙箱 v1（**AppContainer 调研+默认层**，1 周带降级路径）；内置技能：代码审查/skill-creator/自诊断 | 装一个社区 MCP+一个技能跑通；多前端连同一 daemon |
| P4 账户/云/市场 | M5–6 | **IdP 部署（ADR-5）**、relay E2E（**epoch+设备授权表**，含 Web 解密、**分源+CSP**）、远程对话、用量计量（**假名化**）、registry+**Sigstore+副签+扫描门+seed**、**SBOM（CycloneDX）**、**第三方渗透测试（relay/auth/本地 API 三面）** | 网页连家里电脑干活；插件一键安装 |
| P5 自动化 | M7–8 | cron 调度器全语义（**automation 权限模式**）、后台任务+通知、子 agent 编排+消息互通、web search/fetch（小模型摘要） | 定时任务自动跑并推送通知 |
| P6 电脑控制 | M9–10 | computer-use MCP（Win/Mac）、browser-use、document-skills、judge 评审、eval 扩到 100+ | agent 桌面完成真实操作 |

**GA 硬门槛**：P4 验收 = 渗透测试通过 + §12 GA 清单全绿。
**1 人团队砍单顺序**：computer-use → browser-use → document-skills → Web 远程增强（P0–P4 照做，约 8 个月形成商业闭环）。
**P3 后动作**：物理拆包（7 → 17）；评估 Node SEA 单二进制。
**工期影响**：v1.1 安全修订合计 +3–4 周，已摊入上表各阶段（P0 +1 周、P3 +1 周、P4 +1.5 周），R6 持续监控。

**执行进度（2026-09）**：P0–P3 已完成并超概——P3-3 插件装卸+沙箱 v1、P4-1 epoch E2E 加密层提前落地；P2 主体完成（分窗压缩/真 tokenizer 归入 B3）。此后插入两轮增量：**A 级体验轮**（2026-09 交付：bash cd 持久、项目级放行 + /permissions、/cost 用量、LLM 重试退避、/resume + 多行输入、Markdown 渲染+代码高亮）与 **B 级 Agent 能力核**（设计定稿见 docs/roadmap-b.md：子代理 .kcode/agents + task 工具、计划双闸门 + /rewind 检查点、上下文三层压缩、交互补齐、稳固性），B 级完成后再回 P4 主线。**C 级单进程化（2026-09，docs/roadmap-c.md）**：默认形态改为 Claude Code 同款单进程（引擎抽入 packages/session，CLI 内嵌组装，会话 JSONL+resume 不变）；**apps/daemon 与 contracts/localapi 已完全删除**，P4 web 控制台接入形态届时再定。

---

## 10. 风险登记

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | Windows 兼容性（shell/终端/CRLF/沙箱） | 高 | 抽象层+WT 声明+AppContainer 分层方案；P1 起双平台验收 |
| R2 | 多设备会话一致性 | 高 | ADR-8 单活跃设备强约束+租约锁（§5.3），P4 前不做任何同步合并 |
| R3 | E2E 与计费/遥测冲突 | 中 | 双通道：内容密文 + 签名计量事件；BYOK 用量假名化（§5.7） |
| R4 | 插件供应链攻击 | 中 | Sigstore keyless+registry 副签+扫描门+同意页+`--ignore-scripts`+seed+CRL+进程外运行（§5.8） |
| R5 | 上下文成本失控 | 中 | cache 友好组装 P2 定型；eval 监控 token 曲线 |
| R6 | 3 人工期滑坡 | 中 | 每阶段独立可发布；P4 即商业闭环，P5/P6 可延；v1.1 修订 +3–4 周已排入 |
| R7 | **逆向竞品带来的法律/IP 风险**（v1.1 新增） | 中 | 只参考公开文档与 MIT/Apache 开源实现；自有格式差异字段（签名/seed 结构本就不同）；上线前法务过审 |
| R8 | **提示注入残余风险**（v1.1 新增） | 中 | 已知边界声明（§7）；权限分级+第三方技能默认手动+审计；跟踪业界进展 |

---

## 11. 附录

### A. 第一周命令

```bash
mkdir kcode && cd kcode
pnpm init && pnpm add -D turbo typescript vitest oxlint prettier dependency-cruiser -w
# pnpm-workspace.yaml: apps/* services/* packages/* plugins-official/* evals（完整目录树按 §4.4）
# ① packages/contracts：JSONL 事件 schema（v:1）+ Tool/Provider 接口 + epoch 密钥层级
#    + ProviderConfig 双 schema（user/project 分离 + key 受众绑定）+ TUF manifest
#    + .kcode-plugin 清单（路径正则 + 命名空间）+ UsageEvent
# ② packages/core：mock LLM 跑通「消息→工具→回填」最小循环 + 一个回放测试（replay 模式）
# ③ CI：typecheck + vitest + dependency-cruiser 规则（§4.2）
# ④ 威胁模型一页：STRIDE + 六处信任边界图
```

### B. 参考实现映射（移植来源，许可证均兼容）

| 我们的部分 | 参考来源 |
|---|---|
| edit 模糊匹配/diff | OpenCode、Gemini CLI（MIT/Apache；aider fuzzy replace 思路） |
| 沙箱 profile | codex 开源实现（Apache 2.0，macOS seatbelt 部分）；Windows AppContainer 参考 Windows 文档 |
| 压缩策略 | Claude Code 公开博客 |
| hooks/技能/插件结构 | ZCode 公开文档 + `~/.zcode/` 实测目录 |
| 插件 seed 锁定 | ZCode `.zcode-plugin-seed.json`（hash）→ 我们升级为 Sigstore+副签 |
| WebFetch 小模型摘要 | ZCode 同款模式（省贵模型） |
| 更新安全 | TUF / Uptane（角色分离思想）；npm Sigstore provenance |
| 本地通道 | Docker（unix socket）、named pipe 每用户 ACL |

> R7 约束：仅参考公开文档与 MIT/Apache 开源实现；对竞品的逆向产物仅用于格式兼容性事实核查，法务过审后入库。

### C. 命名与品牌锁定（ADR-13）

**决策**：保留 **kcode（快码）**；唯一备选 **tcode**。排除依据为 2026-09-17 npm registry 实测（其余字母+code 候选均被占用或有心智冲突，见下）。

定名当天执行（防 squat，四件事一次做完）：

1. **npm**：注册 org `@kcode`，**并**占住无域缀名 `kcode`（实测可用，防御性发布；安装命令可缩短为 `npm i -g kcode`）；
2. **域名**：`kcode.dev` 主选（本文档头部"待注册"项）；被占则退 `kcode.sh` / `getkcode.dev`；`.com` 可得则一并注册；
3. **GitHub org**：`kcode` 同步注册（registry 签名走 GitHub OIDC，见 §5.8）；
4. **商标**：中国第 9 类（软件）/ 第 42 类（编程服务）检索后申请——npm 干净 ≠ 商标干净，此步不可省。

已排除候选及理由（实测留档）：

| 候选 | 理由 |
|---|---|
| ecode / vcode / mcode / wcode / ucode / bcode / dcode | npm 已被占用（registry 200） |
| xcode | Apple 商标 |
| zcode | 与对标竞品同名 |
| acode / ycode | 既有产品（Android 代码编辑器 / 建站工具） |
| gcode / pcode | 既有术语（CNC 语言 / p-code） |
| qcode | "二维码"歧义 |
| fcode / scode | 心智冲突（小米 F 码 / 衣服尺码） |
| encode / recode / decode | 英文单词，既有品牌过多 |

Logo 方向（供设计参考）：圆角方块深色底 + 高亮单字母 K + 终端元素（`_` 光标或 `❯` 提示符）——笔画少、负空间清晰，16px favicon 与 512px 应用图标均锐利。

---

## 12. 企业就绪与 GA 达标线（v1.1 新增）

| 时点 | 达标线 |
|---|---|
| **v1.1 设计定稿**（本版） | 安全架构无已知廉价漏洞（六处信任边界已闭环）；威胁模型成文（P0 交付） |
| **P4 GA（商业上线）** | ① 第三方渗透测试通过（relay / auth / 本地 API 三面）② Postgres 备份 + 恢复演练 ③ 基础监控告警（Prometheus/Grafana）+ SLO 定义 ④ 事件响应预案（一页）+ security.txt 漏洞披露页 ⑤ SBOM（CycloneDX）随 release ⑥ 目标市场合规清单走完：中国 = ICP 备案/增值电信许可、等保、PIPL（**BYOK 发往境外模型厂商需显式披露+开关**）；海外 = GDPR |
| **GA 后 6–12 月** | SOC 2 / 等保落地；OTel 全量；恶意插件发现-下架-通知 SLA；TUF root key 轮换演练一次 |

**明确不做（过度工程清单）**：HSM/KMS、HashiCorp Vault、OPA 策略引擎、服务网格、K8s、全量 TUF repo（角色分离足够）、MLS 全家桶——3 人团队每引入一个运维面组件，安全预算反而变薄。

**设计水位自评**：安全架构层达到并部分超出同类产品（key 受众绑定、TUF 角色分离、epoch 撤销、Sigstore 为超出项）；企业产品整体水位取决于本表执行，设计是必要条件而非充分条件。

---

## 13. 变更记录

### v1.4（2026-09-24）

- 默认形态切换为 Claude Code 同款单进程：引擎抽入 `packages/session`（composition / subagent / plan-submit / checkpoints），CLI 内嵌组装（`createSession` → `composeSession`）。
- **删除 `apps/daemon` 应用与 `contracts/src/localapi.ts` 本地 API 协议**；CLI/contracts/core/platform/runtime/tools 中的 daemon 残留表述同步清理。
- §0 / §1.2 / §4.1 / §4.2 / §4.4 / §5.6.2 / §9 同步修订（daemon → 单进程）。

### v1.3（2026-09-17）

- 新增 ADR-13：产品名保留 kcode（快码），唯一备选 tcode（依据 2026-09-17 npm 实测占用数据 + logo 字母美学）。
- 新增 §11.C 命名与品牌锁定：定名四动作（npm org+无域缀名、域名、GitHub org、商标 9/42 类）+ 排除候选留档 + logo 方向参考。

### v1.2（2026-09-17）

- 新增 §4.4 完整仓库目录树（P0 脚手架基线，精确到各包关键文件，含读法与部署/产物对应关系）。
- 分源落地：`apps/web` 拆为 `web`（控制台，持设备私钥）+ `market`（市场，UGC sandboxed iframe 渲染），应用数 3→4；§0 / §4.1 同步更新。
- contracts 增补"本地 API 消息" schema 条目（`localapi.ts`）。

### v1.1（2026-09-17）

**六处信任边界修订**：
1. §5.7 项目级配置防 key 外泄：ProviderConfig 双作用域 schema + keychain 受众绑定（双层防御）；
2. §4.1/§5.6 Web 分源：控制台与市场不同 origin，UGC 走 sandboxed iframe+CSP，私钥 passphrase 包裹 + `non-extractable` CryptoKey，浏览器设备密钥为只读级；
3. §5.6 E2E 撤销修正：epoch 换钥模型 + relay 设备授权表 + 恢复码 + 已授权设备批准配对 + 诚实边界声明；
4. §5.6 本地通道：TCP 回环+token → UDS/named pipe 优先（ADR-10），TCP 兜底三件套；
5. §6/§7 Windows 沙箱：降权+黑名单 → 分层（AppContainer 默认层 + 容器加固层 + default-deny 写 + kill switch）+ 威胁模型成文；
6. §5.6 自更新：pin 公钥 → TUF 角色分离 + 带签名的强制升级声明 + 原子替换回滚。

**选型改判与新增 ADR**：ADR-5 自建认证 → 自托管 IdP（Zitadel/Logto）；新增 ADR-10（本地通道）、ADR-11（更新链 TUF + 插件签名 Sigstore）、ADR-12（E2E epoch）。

**应修项**：插件路径正则与命名空间（§4.3）；automation 权限模式（§5.5）；会话锁租约（§5.3）；UsageEvent 假名化（§5.7）；keychain 降级写死 DPAPI/Keychain、禁自制机器密钥（§5.7）；回放安全（§8.2）。

**勘误与新增**：contracts 依赖表述改为"除 zod 外零运行时依赖"；新增 R7（法律/IP）、R8（提示注入）；新增 §12 企业就绪达标线；路线图摊入安全修订工期（+3–4 周）。

### v1.0（2026-09-17）

初版。

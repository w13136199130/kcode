# kcode 设计文档（DESIGN.md）

> **本文是 kcode 的唯一主设计文档。** 后续功能新增、架构调整、实施顺序一律以本文为准；
> 其他设计类文档已删除（其仍有效的内容已折叠进本文），保留两份细则：
> [docs/threat-model.md](./docs/threat-model.md)（安全边界权威）与
> [docs/zcode-benchmark.md](./docs/zcode-benchmark.md)（ZCode 全量模块剖析 + 分步落地设计）。
>
> 状态：v2 · 2026-09-24
> 对标对象：**ZCode**（zai-org/ZCode，Apache-2.0，v3.14.3）、Claude Code、Codex CLI、OpenCode
> 对标方式：只参考公开文档与公开仓库的**设计取舍**，不复制代码；每条结论标注依据 `[ZCode]` / `[kcode 代码]` / `[推断]`。
> 目标水位：**对标 ZCode 全量能力，并在安全（key 受众绑定、DPAPI、只读档不可穿透、E2E）、评测（可回放 + eval 基准）与本地优先上超过它。**

---

## 0. 一页总结

kcode 的**里子（Agent 引擎）已接近对标 ZCode，壳子（协议、平台抽象、UI、治理、发行）还停留在设计阶段**。差距集中在四处，按依赖顺序推进：

1. **会话可靠性未收口（N0，P0）**：手动 `/compact` 不落盘、压缩按固定条数切片会拆开工具调用组、检查点纯内存态——这是**功能正确性问题**，优先于任何新端。
2. **跨端抽象缺失（N1–N2）**：无跨进程协议、无 `IPlatformService`、无共享 UI/设计令牌、无 workspace 身份。这是"能否长出第二、第三个前端"的前提。
3. **治理不可执行（N1）**：`no-circular`/`apps-import-packages` 是 `warn`（实测 exit 0），无行数上限、无死代码检测。
4. **发行链路缺失（N2）**：`bin/kcode.mjs` 用 tsx 加载源码运行，无"干净机器从零安装"路径，阻塞一切外部验证与桌面打包。

```
N0 会话一致性 → N1 契约/治理/身份/日志/令牌 → N2 平台抽象/排队/UI 拆包/发行链
             → N3 通道扩展（host 协议 + Web + Desktop）→ N4 生态与云（市场/账户/调度/电脑控制）
```

**一条重要判断**：单进程 CLI 与桌面/Web 不矛盾。ZCode 用**同一套 stdio 协议同时服务 CLI 与 Electron**，而不是给桌面另起一套。因此 kcode 保留单进程为默认形态，把"进程边界"做成**可选宿主**（§3.3），不为尚未开始的桌面预置常驻进程。

---

## 1. 定位与对标结论

### 1.1 ZCode 的实测架构（来自其公开仓库）

`[ZCode]` 依据：`package.json`、`pnpm-workspace.yaml`、`architecture-policy.yaml`、`README`、`CONTEXT.md`、`AGENTS.md`、`DESIGN.md`、`packages/*/package.json`。

| 层 | 包 | 职责 |
|---|---|---|
| 协议 | `packages/shared`、`packages/rpc` | 协议与类型、RPC 框架；`shared/src/zcode-protocol/` 带主/次版本与运行时校验 |
| 模型 | `packages/provider`、`packages/provider-node` | 跨端公共能力 + Node 实现（分离，避免渲染进程拖入 Node 依赖） |
| 业务 | `packages/services` | 业务服务与持久化；`session`/`storage` 强制 `domain→app→adapters` 分层 |
| 客户端 | `packages/client` | Agent 客户端 SDK |
| 服务 | `packages/server`、`packages/zcode-server-cli` | HTTP/WebSocket、远程连接、独立服务进程管理 |
| 呈现 | `packages/ui`、`packages/web`、`packages/desktop` | 共享 React + Zustand；Web 客户端；Electron |
| 入口 | `apps/zcode-cli` | Agent CLI、TUI、运行时、工具（**其下再嵌套 18 个 `packages/*`**：adapters/bootstrap/core/tui/telemetry/i18n/dynamic-workflow…） |
| 专项 | `packages/formal-proof`、`zcode-cua`、`model-option-map` | 形式化验证、电脑控制、模型选项映射 |

关键事实（决定我们的取舍）：

1. **Desktop 通过 stdio 与 Agent 通信**；每个窗口一个 window-scoped Local Host；本地与远程 workspace 走同一套协议。→ Agent 是**独立进程**，不是内嵌在渲染进程里。
2. **`zcode` 一个命令同时提供 TUI 与 `--web`**，两者都本地运行、不需要 Electron。
3. **平台差异通过依赖注入处理**：组件经 `packages/ui/src/hooks/` 访问服务，平台操作走 `IPlatformService`（`shared/src/platform.ts`），**不直接调用 `window.zcode`**。
4. **`workspaceIdentity` 与 `workspacePath` 分离**：身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`，用于去重/分组/锁定/队列/持久化/请求关联。
5. **架构契约机器可校验**：`architecture-policy.yaml` + `architecture-check.mjs`，进 `verify:pre-push`；含 `maxFileLines: 400`、`maxContractLines: 300`、`maxPublicMethods: 12`、`forbidCycles`、`forbidDeepImports`。另有 `knip`（死代码）、`dep:refs`（导出引用）。
6. **输入准入串行化**：runtime 的 `CommandInbox` 负责 admission，Renderer 只做 pending 乐观展示，Host 持 owner/lease 负责跨序与 stale run 防护。
7. **完整发行链**：`bundle:desktop --os {mac,win,linux} --arch {x64,arm64}`、`build:zcode` 产出可分发 tar.gz；捆绑 ripgrep/bfs/ugrep 多平台二进制并带 SHA256SUMS。
8. **插件市场**：5 类来源（官方市场 / 内置 / CDN / 个人 git·GitHub·URL·本地目录 / 内联）+ 完整生命周期（发现→安装→配置→启停→更新→卸载→恢复）+ 反模式治理。

### 1.2 采纳 / 调整 / 不采纳

| ZCode 做法 | kcode 决策 | 理由 |
|---|---|---|
| Agent 独立进程 + stdio | **采纳，但做成可选宿主**（§3.3） | 单进程对 CLI 更快且已交付；进程边界留给 Desktop 与 `--serve`。同一 `composeSession` 两种宿主 |
| `IPlatformService` 平台抽象 | **采纳**（§3.5/§8 N2-1） | 跨端唯一无法绕过的一层 |
| `workspaceIdentity ?? workspacePath` | **采纳并简化**（§8 N0-6/N1-3） | 直接解决 resume 全局化问题；kcode 无远程场景，先只留 `workspaceKey` 可选位 |
| `CommandInbox` + owner/lease | **采纳**（§8 N2-2） | 对应运行中排队；owner/lease 是防 stale run 的关键 |
| 设计令牌系统（`text-ui-*` + 语义色） | **采纳并扩展为跨端**（§8 N1-5） | 我们多一个终端通道，需把语义令牌映射到 ANSI |
| 机器可校验架构契约（policy + knip） | **采纳，分批**（§6/§8 N1-1） | 现状 `App.tsx` 1992 行远超 400，需先挂例外再拆 |
| UI 禁 `console.log`，统一 logger | **采纳**（§8 N1-4） | 现散落 `console.error`，无法分级 |
| 完整发行链（tar.gz + sha256 + 安装脚本） | **采纳并提前**（§8 N2-4） | 现状 tsx 加载源码，阻塞一切外部验证 |
| 插件商店（5 类来源 + 完整生命周期） | **采纳，但先补加载期 hash 校验**（§8 N3-5→N4-1） | 加载期 hash 都没做，商店无从谈起 |
| `formal-proof`、`zcode-cua`、`postject` bytecode、`swift-bridge`、`node-repl-host`、飞书生态 | **明确不对标**（§8.4） | 与"CLI+桌面"目标无关，避免范围失控 |
| Electron 作为桌面方案 | **采纳，记为可替换**（§8 N3-4） | 与 ZCode 同路、UI 可复用；体积代价真实，保留 Tauri 重评窗口 |
| i18n / dynamic-workflow | **采纳为 N4 远期项**（§8 N4-7/N4-8） | 到生态期再评估 |

### 1.3 我们的差异化优势（必须保留）

对标不是趋同。以下能力是 kcode 已有、ZCode 公开材料中未见对应物的，**在多端化过程中不得丢失**：

1. **API key 受众绑定**（`packages/platform/src/providers/credentials.ts`）：key 只允许发往 keychain 登记的端点，不匹配即硬失败。项目配置被篡改或程序 bug 都无法把 key 发往新端点。
2. **持久放行打不穿只读档**（`packages/extensions/src/permissions/store.ts`）：项目级持久放行与 `trusted-projects.json` 同一信任边界——**项目目录内文件不能给项目自授放行**。
3. **Windows DPAPI 免口令 keychain**：新用户不需要理解"口令环境变量"。
4. **无 IO 的引擎层**（`packages/core` 全端口注入）：这是能做多宿主的结构前提。
5. **可回放会话 + eval 体系**（JSONL append-only + mini-shop 10 任务 + 回放进 CI）：ZCode 没有这么成体系的评测。

---

## 2. 现状基线

> 本节折叠自已删除的 `ARCHITECTURE.md`、`docs/optimization-roadmap.md`、`docs/roadmap-b.md`、`docs/roadmap-c.md`、`docs/m0-validation.md`、`docs/terminal-ux-acceptance.md` 中仍为真的事实。

### 2.1 已交付能力（P0–P3 + A/B/C 轮）

| 域 | 已交付 |
|---|---|
| 核心循环 | Agent loop 状态机、流式输出、并行只读工具、后台任务、子代理（`.kcode/agents` + task 工具）、Plan 双闸门（plan_submit 批准切回执行）、结构化提问（ask_user）、Todo |
| 工具链 | read/write/edit、glob/grep（捆绑 ripgrep）、bash（超时/后台/cd 跨调用持久/!命令直执行）、sessions |
| 上下文 | SKILL.md 渐进加载+触发词、AGENTS.md 记忆、三层压缩（micro 截断→auto 阈值→手动 /compact）、真 tokenizer、resume/分支 |
| 扩展 | MCP（stdio/http/sse + 超时）、hooks（session_start/pre_tool_use/post_tool_use/user_prompt_submit/pre_compact/stop，fail-closed）、斜杠命令、插件装卸 + 沙箱 v1 |
| 权限 | 三态 + 四档（plan/default/acceptEdits/fullAccess）、项目级持久放行 + /permissions、automation 权限语义、只读档不可穿透 |
| 会话 | JSONL append-only + v:1、--resume、/rewind 检查点（已落盘）、/cost、/context、/status、/clear |
| 模型 | BYOK 多厂商（openai-compatible/Ollama/GLM/DeepSeek/中转）、key 受众绑定、DPAPI keychain、瞬态失败指数退避重试 |
| TUI | Ink、Markdown + 语法高亮、工具状态行、Todo 面板、结构化选择题、后台通知、Shift+Tab 权限循环、@ 文件补全、输入历史持久化 |
| 安全 | key 受众绑定、双作用域配置、E2E epoch/ratchet/envelope 加密层（**无 relay 消费者**）、威胁模型 v2 |

### 2.2 验证状态（2026-09-24 实测）

| 检查 | 结果 |
|---|---|
| `pnpm test`（正常用户环境，含 DPAPI） | 55 文件 / 278 用例全部通过，0 跳过 |
| `pnpm typecheck` | 11 任务通过 |
| `pnpm build` | 4 个已配置构建任务通过（**不代表所有应用有产物**） |
| `pnpm lint` | 0 错误 / 12 警告 |
| `pnpm lint:deps` | 0 错误 / 10 警告（含 keychain/DPAPI 类型引用环） |
| 真实模型验收 | mini-shop 10 任务 GLM-5.3 实测 10/10（Windows） |

**未完成的人工验收**：真实 IME/字体/视觉取消延迟（Windows Terminal + VS Code 集成终端）；macOS 侧待跑。

### 2.3 已知缺陷（进入 N 阶段的直接依据）

1. **手动 `/compact` 不落盘**：`composeSession.compactNow()`（`packages/session/src/composition.ts`）走 `opts.onEvent`（仅 UI），不写 sink——自动压缩已落盘（loop 走 `emit()`），只差手动这条。
2. **压缩按固定条数切片**：可能拆开工具调用/结果组，产生孤立 tool result。
3. **检查点纯内存态**：`CheckpointStore` 关闭即清理，重启后不可用。
4. **workspace 身份缺失**：`workspaceId` 仅出现在死接口 `packages/runtime/src/scheduler/index.ts`；会话平铺 `~/.kcode/cli/sessions/`，`--resume latest` 取全局最近。
5. **治理不阻断**：`no-circular`/`apps-import-packages` 为 `warn`；`App.tsx` 1992 行；`contracts/{relay,update,keyhierarchy}.ts` 零消费者。
6. **无发行链**：`bin/kcode.mjs` 用 tsx 加载 TS 源码。
7. **插件加载期不重校验 hash**（threat-model B5 的"目标"项）。
8. **技能自动注入不区分来源**：`match()` 只按触发词过滤，第三方技能默认手动策略未落地。

---

## 3. 目标架构

### 3.1 三个通道，一个会话语义

```
┌─ 通道 ──────────────────────────────────────────────┐
│  CLI/TUI (Ink)   Desktop (Electron)   Web (浏览器)   │
│       │                │                   │        │
│       └────────────────┴───────────────────┘        │
│                        │                            │
│              ┌─────────▼──────────┐                 │
│              │  Agent Host        │  ← 可宿主化      │
│              │  (composeSession)  │                 │
│              └─────────┬──────────┘                 │
└────────────────────────┼────────────────────────────┘
                         │
              会话 JSONL · workspace 身份 · 权限/审计
```

"一个会话语义"= 同一份会话事件流、同一套权限裁决、同一套工具契约，在三端产生**语义等价**的结果。UI 布局可以不同，但"读放行写确认""plan 只读档""回退到某轮"的行为与结果必须一致。

### 3.2 包结构（目标态）

现状 → 目标（`*` 为新增）：

```
packages/
  contracts/    协议 DTO、事件 schema、工具/Provider 接口  ← 增加 protocol 版本与 workspace 字段
  core/         循环、上下文策略、执行管线（零 IO，端口全注入）
  runtime/      SessionRunner、状态归约、JSONL、恢复、检查点
  session/      组装层 composeSession（子代理/计划闸门/检查点接线）
  tools/        文件/命令/搜索/网页执行器
  extensions/   Skills、Hooks、commands、plugins、MCP 适配
  platform/     provider、凭证、系统执行后端
  shared/       零依赖工具（newId / jsonlLine / token 估算）
  ui/ *         跨端 React 组件 + hooks + 状态（Web 与 Desktop 共用）
  design/ *     设计令牌单一来源（§8 N1-5）
apps/
  cli/          终端入口：Ink TUI + 参数解析 + host 拉起
  host/ *       Agent Host 可执行入口（--serve / Desktop 子进程复用）
  web/ *        浏览器客户端
  desktop/ *    Electron Main/Host/Renderer + 打包
services/
  server/ *     HTTP/WebSocket（Web 与远程接入；N4 才实质使用）
```

**保持不变的**：`contracts` 仍是单一契约包（不新开 `shared` 与 `contracts` 双轨，避免 ZCode 那种 `shared` 同时承载工具函数与协议的混用）；`core` 继续零 IO。

**新增包时机**：`ui`/`design` 在 N1-5、N2-3 完成后立；`host` 在 N3 启用进程边界时立；`web`/`desktop` 在 N0 收口后立。**不为"看起来对齐"建空壳**（`apps/web`/`apps/market`/`services/server` 曾长期零源码占位，是反面教材）。

### 3.3 Agent Host 的两种宿主

| 模式 | 触发 | 组装位置 | 端口实现 |
|---|---|---|---|
| **内嵌**（默认） | `kcode` | CLI 进程内 | 直接函数调用 |
| **子进程** | `kcode --serve`；Desktop | `apps/host` 子进程 | stdio 上的类型化协议 |

两种模式**共用同一个 `composeSession`**，差异仅在端口的实现对象。这是 `[kcode 代码]` `packages/session/src/composition.ts` 已具备的能力（llmFactory/onEvent/asker/planAsker 全为注入项）。

```
内嵌：  CLI ──────────────────► composeSession(ports=直接调用)
子进程：CLI/Electron ──stdio──► apps/host ──► composeSession(ports=协议转发)
```

**为什么不做成 daemon 常驻**（保留 C 级决策）：daemon-first 的实测税负真实存在——① 环境继承错位（继承首个终端口令环境，换终端即"口令错误"）；② 协议版本 churn（一周 3→10）；③ 僵尸进程/死 pid/管道 EADDRINUSE。**子进程宿主天然规避第 1 条**（host 是父进程的子进程，环境由 spawn 时给定）。因此：**进程边界按需启用，不预置常驻进程；一旦启用，host 必须是当前前端的子进程。**

### 3.4 会话数据流

```
用户输入 ──► CommandInbox(admission) ──► AgentLoop.run
                                          │
                     ┌────────────────────┼────────────────────┐
                     ▼                    ▼                    ▼
                LLM provider        工具执行(权限裁决)      事件发射
                     │                    │                    │
                     └────────────────────┴────────┬───────────┘
                                                   ▼
                                    SessionEvent ──► JSONL(append-only)
                                                   │
                                                   ▼
                                    各端 UI（语义等价地消费同一事件流）
```

### 3.5 凭证边界（架构约束，非建议）

**key 明文只能在 host 进程内出现。**

- `apps/cli`、`packages/ui`、`apps/desktop` 的渲染进程**不得**持有明文 key。
- 需要"验证 key 是否可用"时，由 host 提供 `probe(keyRef)` 返回布尔，而非返回 key。
- 每次网络请求的 key 注入发生在 host 的 provider 层。
- **受众绑定校验（`credentials.ts`）是这条边界上的硬闸门**，任何重构不得绕过。

理由：单进程化后 key 与工具执行同进程（见 threat-model.md 已知边界 3）。引入 host 子进程是**修复这一残余风险的机会**，不应浪费。

### 3.6 平台抽象 `IPlatformService`（依赖：协议冻结后）

```ts
export interface IPlatformService {
  readonly kind: "cli" | "desktop" | "web";
  credentials: { get(ref: string): Promise<string | null> };  // web/desktop 渲染进程拿到的是代理，不是明文
  native?: { revealInOs(path: string): Promise<void>; openExternal(url: string): Promise<void> };
  paths: { workspaceRoot(): string; artifactsDir(sessionId: string): string };
  process?: { spawnTerminal?(cmd: string): Promise<void> };
}
```

约束（`[ZCode]` AGENTS.md 明令）：UI 组件不得直接调用平台 API，只经 `packages/ui/src/hooks/` 访问服务；业务代码不得出现 `window.*` 式平台判断。

---

## 4. 技术栈（定版清单）

| 层 | 选型 | 备注 |
|---|---|---|
| 语言/运行时 | TypeScript 5 strict + Node.js 22 LTS | ESM 输出 |
| Monorepo | pnpm workspaces + Turborepo | 单层扁平（不学 ZCode 的双层嵌套） |
| 构建 | tsup（esbuild 内核） | CLI 单文件 bundle；Node SEA 单二进制后评估 |
| 模型接入 | Vercel AI SDK（`ai` + `@ai-sdk/openai-compatible`）+ 自有 AgentLoop | `openai-compatible` 能解析 GLM/DeepSeek 的 `reasoning_content` |
| 插件协议 | `@modelcontextprotocol/sdk` | 工具名空间 `mcp__<server>__<tool>` |
| CLI TUI | Ink + React + marked + highlight.js | 要求 Windows Terminal |
| 本地存储 | 会话 JSONL（append-only）+ SQLite（有索引/并发/调度需求时引入） | 数据库替换不能修复回放逻辑 |
| 加密 | node:crypto + libsodium（需要时） | keychain：DPAPI/Keychain/passphrase 降级 |
| 网络 | ws / Node fetch | 远程访问 P4 评估 |
| Schema | zod | contracts 地基 |
| 日志 | pino（服务侧）+ 统一 logger（UI 侧，N1-4） | 禁业务代码 console.log |
| 测试 | vitest | 单测 + 回放 + E2E + 验收 |
| Lint | oxlint + prettier | |
| 治理 | dependency-cruiser + knip（N1-1） | 门禁升 error |
| 桌面 | Electron（N3-4，记为可替换） | CLI/Web 模式不打包 Electron |

---

## 5. 关键设计决策（ADR 精简）

| # | 决策 | 理由 |
|---|---|---|
| ADR-1 | TS 单语言，**自研 loop、不 fork** | ZCode 逆向实证同路线；fork 会在账户/市场渗透核心时反噬 |
| ADR-2 | 单进程 CLI + 可选 host 子进程（无常驻 daemon） | daemon 税负实测；进程边界按需启用 |
| ADR-3 | 扩展层全走开放标准（MCP + SKILL.md + 插件） | 市场第一天兼容既有生态 |
| ADR-4 | core headless、零 IO、端口全注入 | 多宿主的结构前提 |
| ADR-5 | 认证用自托管 IdP（Zitadel/Logto），不自研 | 自研 auth 边角路径是漏洞长尾 |
| ADR-6 | 8 物理包 + 逻辑模块按边界成熟度拆包 | 3 人团队维护 17 包是负资产 |
| ADR-7 | 会话 JSONL append-only + `v` 版本字段 | 天然回放做 eval 夹具 |
| ADR-8 | 多设备单活跃设备约束 | 避免 CRDT 合并复杂度（N4 前不做同步） |
| ADR-9 | 身份与模型来源解耦（登录/BYOK/OpenAI 兼容三模式） | 零门槛获客 + 订阅留路径 |
| ADR-10 | host 通道优先 stdio；远程走 WSS E2E | 访问控制即进程边界 |
| ADR-11 | 更新链 TUF 角色分离；插件签名 Sigstore keyless | CI 钥匙泄露可轮换无需发版 |
| ADR-12 | E2E 会话密钥 epoch + HKDF 逐消息 ratchet | 撤销即时生效（N4 落地） |
| ADR-13 | 产品名 kcode（快码） | npm 实测占用数据 + 品牌锁定 |

---

## 6. 模块边界与依赖治理

### 6.1 分层依赖模型

```text
组合层  apps/cli + packages/session ──► （唯一允许 import 一切的地方）
引擎层  core ──► 定义 Provider 接口，依赖 contracts
能力层  tools / runtime / extensions / platform ──► 实现 engine 接口
底座    contracts / shared（零依赖）
```

规则（CI 用 dependency-cruiser 锁死）：

1. 能力层之间禁止互引（tools 不得 import runtime 等）——**已 error**；
2. 任何包不得反向依赖引擎层——**已 error**；
3. 底座（contracts/shared）不得依赖上层——**已 error**；
4. `no-circular`、`apps-import-packages`、`engine-to-capability`——**当前 warn，N1-1 升 error**。

### 6.2 治理升级分批（`[ZCode]` 采纳）

| 批次 | 动作 | 立即影响 |
|---|---|---|
| B1 | `no-circular` 升 `error`；修掉 `platform/src/auth/keychain.ts ↔ dpapi-keychain.ts` 类型环（抽接口到第三文件） | 先建立"门禁会红"的事实 |
| B2 | 新增行数上限：`maxFileLines 500`、`maxContractLines 300`、`maxPublicMethods 12`；超标文件挂显式例外清单（含负责人与拆除期限） | `App.tsx` 等进例外，但新增文件立即受限 |
| B3 | 引入 `knip` 死代码检测 | 暴露 `contracts/{relay,update,keyhierarchy}.ts` 等零消费者代码 |
| B4 | 例外清零后移除例外机制，规则升 `error` | 门禁成为真门禁 |

### 6.3 工程纪律（`[ZCode]` AGENTS.md 采纳）

1. 新功能或改行为前先更新本文对应章节；先明确产品规则、状态所有者、接口与验收场景，再写实现。
2. 未明确要求改代码时先调查原因；区分"已确认原因"与"待验证假设"。
3. 发现设计缺陷先与用户对焦，不叠加局部补丁。
4. 有行为改动先补测试；两处改动交互时需 E2E 场景；实际执行验证。
5. typecheck 与 lint 必须通过，报告真实结果。
6. 注释说明"为什么"（中文），而非复述"做了什么"。
7. 文档不夸大：未实现的能力写成"目标"，不写成能力。

---

## 7. 安全边界（摘要）

权威细则见 [docs/threat-model.md](./docs/threat-model.md)（单进程版 v2）。五处信任边界：

| 边界 | 主要威胁 | 缓解状态 |
|---|---|---|
| B1 配置/上下文 → 端点解析 | 伪装端点窃 key | 双作用域 schema + 受众绑定 **已实现** |
| B2 keychain → 进程内存 → 出境 | 明文 key 外发 | AES-256-GCM/DPAPI **已实现**；key 明文与工具同进程 = 残余风险（N3-2 收敛到 host 修复） |
| B3 不可信内容 → 模型 → 工具 | 提示注入越权 | 规则引擎默认 deny + 权限三态 + 只读档不可穿透 **已实现**；无 OS 沙箱 **目标** |
| B4 进程 → 命令执行 | 任意命令 | 权限确认 + 超时 + 进程树清理 + /trust 门控 **已实现** |
| B5 插件/技能 → 本机 | 供应链攻击 | 安装纯文件复制 + seed **已实现**；加载期 hash + Sigstore **目标（N3-5/N4-4）** |

**已知边界（诚实声明）**：提示注入未解；无 OS 级沙箱（"工具执行前确认"≠沙箱）；凭据与代码同进程；插件加载期完整性未校验；技能自动注入不区分来源；BYOK 远端调用意味着源码会离开本机。

---

## 8. 优先级路线图（细致计划拆解）

> 每个动作的**详细设计思路 + 对标依据**见 [docs/zcode-benchmark.md](./docs/zcode-benchmark.md) §4。
> 优先级定义：**P0** 数据正确性/安全边界/交付阻塞；**P1** 可日常使用、可交付 + 多端结构准备；**P2** 扩展通道与生态；**P3** 规模化与商业化。

### 8.1 阶段 N0：会话一致性收口（P0，先于一切）

**目标**：重启后回退内容不复活、压缩可回放、检查点可恢复、JSONL 崩溃可恢复。

**顺序要求**：先落 5 个回归场景的失败测试，再改事件契约（契约一改，无法再用旧行为证明新行为正确）。

| ID | 项 | 现状缺陷 | 验收标准 | 入口文件 |
|---|---|---|---|---|
| N0-1 | 手动 `/compact` 落盘 | `compactNow()` 只 `onEvent` 不写 sink | `/compact` → 立即关闭 → 恢复后摘要仍在 | `packages/session/src/composition.ts` |
| N0-2 | 压缩按完整轮次/调用组切分 | 现固定 10 条切片 | 8–10 条短历史含并行工具调用无孤立 tool result | `packages/core/src/context/compact.ts` |
| N0-3 | `compaction_summary` 补覆盖范围 + 锚点 | 摘要字段不全 | 在线/回放历史逐条一致；摘要不与原文重复 | `packages/contracts/src/session.ts` |
| N0-4 | 检查点持久化 | 纯内存，关闭即 `rm` | 重启后可列出可用检查点 | `packages/session/src/checkpoints.ts` |
| N0-5 | JSONL 追加语义/崩溃恢复 | 截断/写入失败/崩溃未定义 | 恢复有效前缀；不自动重放结果未知的写操作 | `packages/runtime/src/session/jsonl.ts` |
| N0-6 | workspace 身份绑定 | `workspaceId` 仅死接口，`--resume latest` 全局 | `latest` 默认当前项目内最近；`/sessions` 按项目分组 | `packages/runtime/src/session/`、`composeSession` |

### 8.2 阶段 N1：契约与地基（P0–P1）

| ID | 项 | 依赖 | 验收标准 |
|---|---|---|---|
| N1-1 | 治理门禁升 error（§6.2 B1–B3） | N0 | `no-circular` 升 error；修类型环；knip 上 CI |
| N1-2 | 冻结跨进程协议 `contracts/protocol.ts`（主/次版本 + 运行时校验 + 一致性测试） | N0 | 故意改一处字段形状会让一致性测试失败 |
| N1-3 | workspace 身份贯穿（`ToolContext`/事件/`listSessions`） | N0 | 同 N0-6 |
| N1-4 | 统一 logger（`createServiceLogger` + `packages/ui/src/logger.ts`） | 无 | 禁业务代码 `console.log`，分级生效 |
| N1-5 | 设计令牌单一来源 + 终端映射器（先只服务 CLI） | 无 | `packages/design/tokens` 成立；正文继承终端前景色 |

### 8.3 阶段 N2：多端地基（P1）

| ID | 项 | 依赖 | 验收标准 |
|---|---|---|---|
| N2-1 | `IPlatformService` + 依赖注入装配 | N1-2 | UI 不碰平台 API |
| N2-2 | `CommandInbox` + owner/lease | N1-2/N1-3 | 运行中提交 3 条输入按序执行；kill -9 host 重启无幽灵 run 写回 |
| N2-3 | `App.tsx` 拆为 `theme/ terminal/ state/ transcript/ input/ dialogs/ status/`；`packages/ui` 立包 | N2-1 | 新增文件立即受限（maxFileLines 500） |
| N2-4 | 发行链：tar.gz + sha256 + `latest.json` + 安装脚本 | N1 | 干净机器从零安装后首个任务通过 |
| N2-5 | 例外清零，门禁升 error（§6.2 B4） | N2-3 | 门禁成真门禁 |

> N2-4 提前的理由：现状 `bin/kcode.mjs` 用 tsx 加载源码，只有 4 个包有 build。没有"干净机器从零安装"路径，会阻塞一切外部验证与桌面打包。

### 8.4 阶段 N3：通道扩展（P2）

| ID | 项 | 依赖 | 说明 |
|---|---|---|---|
| N3-1 | `apps/host` + 子进程宿主 + stdio 协议 | N1-2/N2-1 | Desktop 与 Web 共同前置 |
| N3-2 | 凭证边界收敛到 host（§3.5） | N3-1 | 与 N3-1 同批；key 只在 host |
| N3-3 | Web 客户端（React + Vite，复用 ui+design） | N3-1 | 远程访问：TLS 非可选 + 令牌默认生成 + 权限默认收紧 |
| N3-4 | Desktop（Electron，可替换） | N3-1 | 复用 ui + host 协议 |
| N3-5 | 插件加载期 hash 校验 | 无 | 独立于商店；篡改拒绝加载 |

### 8.5 阶段 N4：生态与云（P3+）

| ID | 项 | 说明 |
|---|---|---|
| N4-1 | 插件市场/商店 | 5 类来源 + 完整生命周期（对标 ZCode CONTEXT.md 领域词汇） |
| N4-2 | 账户 IdP + relay E2E + 远程对话 | E2E 层已落地，补 relay 消费者 |
| N4-3 | 用量计量 + 遥测（opt-in，BYOK 假名化） | |
| N4-4 | registry + Sigstore keyless + 扫描门 + seed 锁定 + CRL | 供应链闭环 |
| N4-5 | cron 调度器全语义 + automation 权限 | `scheduler/index.ts` 现仅接口 |
| N4-6 | computer-use / browser-use | 对标 zcode-cua；作为插件形态 |
| N4-7 | i18n 国际化 | 对标 ZCode i18n 包 |
| N4-8 | dynamic-workflow 工作流编排 | 对标 ZCode dynamic-workflow；先评估是否纳入 |

### 8.6 明确不对标（约束范围）

`formal-proof`（形式化验证）、`zcode-cua` 独立进程形态、`postject` bytecode 保护、`swift-bridge`、`node-repl-host`、飞书生态集成、多设备同步合并（N4 前不做）。**如确需某项，先改本文再开工。**

---

## 9. 功能对标清单（ZCode 全量 × kcode 状态）

| 域 | ZCode | kcode | 缺口 |
|---|---|---|---|
| Agent 循环/流式/并行工具/后台任务 | ✅ | ✅ | 无 |
| 工具链 read/write/edit/grep/glob/bash | ✅ | ✅ | 无 |
| 子代理 | ✅ | ✅ | 无 |
| Plan/结构化提问/Todo | ✅ | ✅ | 无 |
| 上下文压缩/SKILL/AGENTS.md/resume | ✅ | ✅ | 无 |
| MCP/Hooks/斜杠命令/插件安装 | ✅ | ✅ | 加载期 hash（N3-5） |
| 插件市场/商店 | ✅ | ⚠️ 装卸 | 高（N4-1） |
| 桌面端 | ✅ | ❌ | 高（N3-4） |
| Web 端 + 远程访问 | ✅ | ❌ | 高（N3-3） |
| 跨进程协议/RPC | ✅ | ❌ | 高（N1-2/N3-1） |
| 平台抽象 | ✅ | ❌ | 高（N2-1） |
| 共享 UI + 设计令牌 | ✅ | ❌ | 高（N1-5/N2-3） |
| workspace 身份 | ✅ | ❌ | 高（N0-6） |
| 架构治理（policy + knip） | ✅ | ⚠️ warn | 高（N1-1） |
| 发行链 | ✅ | ❌ | 高（N2-4） |
| i18n | ✅ | ❌ | 中（N4-7） |
| 电脑控制 | ✅ | ❌ | 中（N4-6） |
| 浏览器控制 | ✅ | ❌ | 中（N4-6） |
| 动态工作流 | ✅ | ❌ | 中（N4-8） |
| 遥测 | ✅ | ⚠️ 本地 | 低（N4-3） |

---

## 10. 待决问题

| # | 问题 | 状态 / 倾向 |
|---|---|---|
| Q1 | Desktop 框架 | **已定：Electron**（2026-09-24）；CLI/Web 不打包 Electron；Tauri 不再候选 |
| Q2 | `packages/ui` 是否含 Ink 组件 | **不含**；只放 DOM 组件，Ink 留在 apps/cli，两端共享语义层 |
| Q3 | Web 端是否需要远程（非本机） | **已确认：需要**；故 services/server 的鉴权 + TLS + 审计须与 Web 端同期（N3-3） |
| Q4 | dynamic-workflow 是否对标 | N4-8 评估，倾向"用户明确需要时再纳" |

---

## 11. 变更记录

### v3（2026-09-24）

- 新增 [docs/zcode-benchmark.md](./docs/zcode-benchmark.md)：ZCode（提交 `29628c9`）全量功能模块剖析（协议/RPC/引擎/TUI/adapters/服务/UI/桌面/治理/插件市场/专项包）+ kcode 分步落地设计（§8 每步的详细设计思路 + 对标依据 + 简化/不对标项）。
- 头部文档关系与 §8 增加对该文档的引用。

### v2（2026-09-24）

- 确立本文为**唯一主设计文档**；折叠并删除 `ARCHITECTURE.md`、`docs/optimization-roadmap.md`、`docs/roadmap-b.md`、`docs/roadmap-c.md`、`docs/m0-validation.md`、`docs/terminal-ux-acceptance.md`（其仍有效内容并入本文 §2、§5、§8）。
- 重排路线图为 N0–N4 单线（合并旧 M0–M5 与 DESIGN v1 的 N0–N3），按优先级 P0→P3 排序。
- 补全功能对标清单（§9）、差异化优势（§1.3）、治理分批（§6.2）、凭证边界约束（§3.5）。
- 保留 `docs/threat-model.md` 为安全权威细则。

### v1（2026-09-24）

初版（单进程化后的目标形态、ZCode 取舍对照、N0–N3 路线）。

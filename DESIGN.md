# kcode 设计文档（DESIGN.md）

> **本文是 kcode 的唯一主设计文档。** 后续功能新增、架构调整、实施顺序一律以本文为准；
> 其他设计类文档已删除（其仍有效的内容已折叠进本文），保留两份细则：
> [docs/threat-model.md](./docs/threat-model.md)（安全边界权威）与
> [docs/zcode-benchmark.md](./docs/zcode-benchmark.md)（ZCode 全量模块剖析 + 分步落地设计）。
>
> 状态：v5 · 2026-09-29
> 对标对象：**ZCode**（zai-org/ZCode，Apache-2.0，v3.14.3）、Claude Code、Codex CLI、OpenCode
> 对标方式：只参考公开文档与公开仓库的**设计取舍**，不复制代码；每条结论标注依据 `[ZCode]` / `[kcode 代码]` / `[推断]`。
> 目标水位：**对标 ZCode 全量能力，并在安全（key 受众绑定、DPAPI、只读档不可穿透、E2E）、评测（可回放 + eval 基准）与本地优先上超过它。**

---

## 0. 一页总结

kcode 的**里子（Agent 引擎）已对标 ZCode；壳子的地基（N1 契约/治理/身份/日志/令牌、N2 平台抽象/排队/UI 拆包/发行链）与通道前三项（N3-1 host 宿主、N3-2 凭证边界、N3-3 Web+中继）均已落地**（2026-09-29 复核）。剩余主线四处：

1. **会话一致性收尾（N0，P0）**：检查点持久化与 workspace 身份已落地；待复核项：手动 `/compact` 是否落盘、压缩切片是否按完整轮次（§2.3）。
2. **CLI 入口层与 TUI 交互补全（N3C，P1 快赢批，§8.4b）**：headless flag 组（`-p/--mode/--json` 等）、`doctor`、管理子命令、状态栏常驻信息与逐卡展开等交互件——用户最可感、成本最低、无依赖可插队的一批。
3. **通道收尾（N3-4/5）**：Desktop 与插件加载期 hash 校验。
4. **生态与云（N4）**：插件市场、账户 IdP、调度、长期 Memory、遥测。

```
N0 会话一致性 → N1 契约/治理/身份/日志/令牌 ✅ → N2 平台抽象/排队/UI 拆包/发行链 ✅
             → N3 通道扩展（host ✅ · 凭证边界 ✅ · Web/中继 ✅ · Desktop 待 · 插件 hash 待）→ N4 生态与云（市场/账户/调度/电脑控制）
             ↘ N3C CLI 入口层/TUI 交互快赢批（P1，无依赖可随时插队）
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

### 1.4 对标口径与分档

- **快照口径**：对标锁定 ZCode 快照（提交 `29628c9`），**不追实时版本**——ZCode 每周发版，3 人规模追实时不现实；上游演进按需复核（见 [docs/zcode-benchmark.md](./docs/zcode-benchmark.md) §6）。
- **补录口径**：CLI 入口与 TUI 交互的盲区以 zcode CLI 0.16.9 安装版实测 surface + Claude Code / OpenCode 公开文档补录（2026-09-29，见 §8.4b/§9.2）；上游演进仍按快照口径不追。
- **对标分档**：功能对标（有等价能力，默认档）／体验对标（手感/信息密度到 ZCode 档）／不追（明确不做）。分档与取舍见 [docs/zcode-benchmark.md](./docs/zcode-benchmark.md) §5。
- **人力量级**：N3/N4 每个动作的"人周"量级估算见 [docs/zcode-benchmark.md](./docs/zcode-benchmark.md) §4——用于排期取舍，非工期承诺。
- **关键取舍**：桌面/Web 在 kcode 规模下先按**功能对标**落地，体验对标 ZCode 桌面为二期目标。

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

### 2.3 已知缺陷（2026-09-29 复核）

**仍开放**：

1. **技能自动注入不区分来源**：`match()` 只按触发词过滤，第三方技能默认手动策略未落地（含 frontmatter `allowed-tools`/`disable-model-invocation` 两字段，benchmark §1.15）。
2. **`contracts/{update,keyhierarchy}.ts` 零消费者**：knip 已挂 CI，待消费或删除。

**已收口**（移出缺陷清单，防过时信息误导）：手动 `/compact` 落盘（compactNow 经 sink 写盘，`compact-persistence.test.ts` 锁定）、压缩按完整轮次切片+锚点（`compact.ts` 含 covered/taskAnchor，不再产生孤立 tool result）、插件加载期 hash 校验（N3-5：`verifyPluginSeed` + `buildExtensionRoots` 拒载，seed 排除自身）、检查点持久化（N0-4，`manifest.json`+快照落盘重启可用）、workspace 身份（N0-6/N1-3，`workspaceKey` 贯穿 resume 分组）、治理门禁（N2-5，规则 error + `gates-exceptions.json` 登记）、发行链（N2-4，tsup bundle + 安装器双端）。

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
- key 录入（写 keychain）同样经 host RPC 落盘——前端侧的 `IPlatformService` 不暴露 `openPassphraseKeychain`/`openSecureKeychain`（按进程拆两半，见 §8.4 N3-2 注 E）。
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
4. `no-circular`、`apps-import-packages`、`engine-to-capability`——**当前 warn，N1-1 升 error**；
5. `ui-no-platform-impl`（N2-1 落地）：`apps/cli/src/(tui|main)` 禁止 import `@kcode/platform`——平台能力只经 `contracts.IPlatformService` 注入，装配点唯一 `bootstrap.ts`——**已 error**。

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
| B5 插件/技能 → 本机 | 供应链攻击 | 安装纯文件复制 + seed **已实现**；加载期 hash 校验（N3-5：篡改拒载）**已实现**；Sigstore 签名 **目标（N4-4）** |

**已知边界（诚实声明）**：提示注入未解；无 OS 级沙箱（"工具执行前确认"≠沙箱）；凭据与代码同进程；插件 seed 本身可被连同内容一起重算伪造（防伪需 N4-4 签名，加载期校验防的是"装后被改"而非"装时即恶"）；技能自动注入不区分来源；BYOK 远端调用意味着源码会离开本机。

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
| N1-4 | 统一 logger（`createServiceLogger` + `packages/shared/src/logger.ts`） | 无 | 禁业务代码 `console.log`，分级生效；oxlint `no-console: error` 机器化（白名单仅：logger 实现、evals 报告器、services 占位、cli scripts/bin 的界面出口） |
| N1-5 | 设计令牌单一来源 + 终端映射器（先只服务 CLI） | 无 | `packages/design/tokens` 成立；正文继承终端前景色 |

### 8.3 阶段 N2：多端地基（P1）

| ID | 项 | 依赖 | 验收标准 |
|---|---|---|---|
| N2-1 | `IPlatformService` + 依赖注入装配 | N1-2 | UI 不碰平台 API（§6 规则5 机器校验：装配点唯一 bootstrap.ts）——**已落地** |
| N2-2 | `RuntimeCommandQueue`（priority now/next/later）+ 单 reservation；busy 时入队不抛错 | N1-2/N1-3 | 运行中提交 3 条输入按序执行（简化版，不抄 ZCode 500 行幂等网关；owner/lease 随 host 进程挪至 N3-1）——**已落地**（runtime 队列 + session 句柄暴露 + CLI 输入区常驻/中断清空；TUI 集成测试覆盖验收场景） |
| N2-3 | `App.tsx` 拆为 `theme/ terminal/ state/ transcript/ input/ dialogs/ status/`；`packages/ui` 立包（注入模式见下方注）；工具统一 `ToolEntry` 契约（schema+permission+resultBudget+timeout） | N2-1 | 新增文件立即受限（maxFileLines 500，oxlint `max-lines` 覆盖 `tui/**`；全仓启用随 N2-5 清零存量超限后）；Ink 与 DOM 组件均经 `useServices` 取服务，不直接 import runtime/core——**已落地**（App.tsx 2078→484 行；ToolEntry：`ToolDefinition` 扩展 permission/timeoutMs/resultBudget，档位裁决改声明驱动） |
| N2-4 | 发行链：tar.gz + sha256 + `latest.json` + 安装脚本 | N1 | 干净机器从零安装后首个任务通过——**已落地**（tsup 单文件 bundle + yoga.wasm + rg 平台包随包；`pnpm release` 一键出产物；install.sh/install.ps1 双端安装器；干净目录解包 + 真实 LLM 首任务验收通过） |
| N2-5 | 例外清零，门禁升 error（§6.2 B4）+ 例外登记制（对标 ZCode expired-exception） | N2-3 | `gates-exceptions.json` 每条例外带理由与到期日，过期即 CI fail；门禁成真门禁——**已落地**（规则4 升 error＝app 只准经 `src/index.ts` 公开入口 import 包，零警告；`max-lines: error 500` 全仓启用（loop.ts 581→495、composition.ts 553→495 拆分达标）；`gates:check` 挂 CI 校验过期与漂移，现存 no-console 白名单 5 条已入登记） |

> **N2-3 注入模式（对标 ZCode `useServices`/`IServiceAccessor`，先定后拆）**：`packages/ui` 分 DOM-free 内核与 DOM 组件两层——`services/`（`ServiceAccessor` 接口 + `ServicesProvider`/`useServices` React Context）与 `state/`（Zustand slice）不依赖 DOM，Ink（apps/cli）与 DOM（N3 web/desktop）两端同用；组件只经 accessor + store 取数，不直接 import runtime/core。宿主（CLI bootstrap / Web 入口）负责实现并注入 accessor。Ink 即 React，Context 在两端行为一致，无需两套注入。不定此层先拆包，拆出的组件仍是 cli 私有，立包白立。

> N2-4 提前的理由：现状 `bin/kcode.mjs` 用 tsx 加载源码，只有 4 个包有 build。没有"干净机器从零安装"路径，会阻塞一切外部验证与桌面打包。

> **N2-5 例外登记制（对标 ZCode expired-exception）**：清零只解决存量——例外会再长出来，无死期的豁免会重新烂掉。所有 lint/depcruise/knip 豁免集中登记于 `gates-exceptions.json`（规则、文件、理由、到期日；期限上限一个季度，续期须显式改期留痕），`pnpm gates:check` 挂 CI：条目过期即 fail。ZCode 的基线感知（sha256 记存量违规）不引入——kcode 例外量小，清零 + 登记即可；现存 no-console 白名单随 N2-5 一并迁入登记。

### 8.4 阶段 N3：通道扩展（P2）

| ID | 项 | 依赖 | 说明 |
|---|---|---|---|
| N3-1 | `apps/host` + 子进程宿主 + stdio 协议 + lease 机制（自 N2-2 挪入：host 进程出现，防幽灵 run 才有舞台；设计注 A–D 见下方） | N1-2/N2-1 | kill -9 host 重启无幽灵 run 写回；Desktop 与 Web 共同前置——**已落地**（`apps/host` stdio 宿主：boot/server/session 三模块；`contracts/host-protocol.ts` 词汇表 + `host_lease` 事件；`runtime` HostClient 传输；4 个集成测试全绿：握手+事件流 / kill -9 lease+1 无幽灵 / 双活拒绝 / 断连 fail-closed） |
| N3-2 | 凭证边界收敛到 host（§3.5；设计注 E 见下方） | N3-1 | 与 N3-1 同批；key 只在 host——**已落地**（`PlatformClientPort` 前端接口 + `platformClientAdapter` 本地适配器；Login 向导改走 `saveKey`；宿主协议新增 `platform/probe + platform/save_key` 方法） |
| N3-3 | Web 客户端（React + Vite，复用 ui+design） | N3-1 | 远程访问：TLS 非可选 + 令牌默认生成 + 权限默认收紧——**已落地**（中继服务器 + Web 客户端；设计令牌对接 + 审批面板 + Markdown 渲染 + 流式文本 + 暗色自适应） |
| N3-4 | Desktop（Electron，可替换；设计注 F 见下方） | N3-1 | 复用 ui + host 协议 |
| N3-5 | 插件加载期 hash 校验 | 无 | 独立于商店；篡改拒绝加载——**已落地**（`verifyPluginSeed` 重算内容哈希与 seed 比对、seed 自身排除；`buildExtensionRoots` 校验失败拒绝装载并 onWarn，会话与 CLI 盘点同点收口；`plugin list` 显示 ⚠ 完整性校验失败） |

> **N3-1 注 A（排空权威在 host，N3 设计修订）**：N2-2 的排队/排空（reservation、drain 递归）在单进程下由 CLI App 驱动；进程边界后排空权威**移入 host**——host 收 `session/submit`（含 priority）后自行排队/预约/执行/取下一条，CLI/Web 只投递命令并收 `queue/change` 事件。前端侧以 **SessionProxy** 消费：与 `SessionHandle`/`CliServices` 同形的接口、方法转发 RPC（N2-3 注入缝的价值兑现——组件不改）。断连重连后队列状态不丢失（它在 host）。

> **N3-1 注 B（lease 机制：logEpoch 即租约）**：host 持 `(hostId, pid, startedAt)`，在 session JSONL 写 run 租约标记；**host 重启即 `logEpoch`+1**（`EventCursor` 既有字段），新 host 检测悬空租约（旧 pid 不存活 / 心跳超时）→ 拒接旧 run 上下文、按有效前缀（N0-5 语义）重建；`commandId` 幂等 + `baseRevision` CAS 拦截 stale 命令重放。三者合起来就是"kill -9 无幽灵写回"的机制本体。

> **N3-1 注 C（协议词汇表与流式细节）**：N1-2 冻结的是信封（Hello/CommandEnvelope/EventCursor），N3-1 在其上定义词汇：`session/create`、`session/submit(priority)`、`queue/change`、`delta`、`reasoning_delta`、`ask/request ↔ ask/response`（审批往返）、`plan/approval`、`interrupt`、`sessions/list`。两条硬规则：① 审批跨进程后为关联请求——**断连/超时未决 ask 一律结算 deny（fail-closed）**；② 流式合帧（B3 的 reasoning 250ms 批量）在 host 侧做，避免逐 delta 过线。

> **N3-1 注 D（host 粒度：每会话一进程）**：host = 会话级进程（对标 ZCode 每窗口一个 host）——与 `SessionRunner` 单飞语义、崩溃隔离天然吻合；桌面=每窗口=每会话；Web 多会话 = 多 host + 本地连接注册表；远程注册表（ssh/wsl/docker）随 N4-2。**不做** host 内多会话状态机（不必要的复杂度）。

> **N3-2 注 E（IPlatformService 按进程拆两半）**：host 侧持有完整 keychain 实现（openPassphraseKeychain/openSecureKeychain 等）；**前端侧接口只暴露** `secureStorageAvailable` + `probe(keyRef)` + `saveKey(...)`（经 RPC 落 host）——open*Keychain 不得跨进程暴露。Login 向导的 key 录入改为 RPC 调用（现直调平台实现的路径随 N3-1 切换）。

> **N3-4 注 F（Electron 形态定死）**：每窗口 `utilityProcess.fork` 一个 host + `MessageChannelMain` 传 port；stdout 只跑 RPC、stderr 分离（诊断/日志各走各的）。不用 renderer fork（渲染进程无 node 权限是安全边界，不是实现细节）。自更新数据源复用 N2-4 的 `latest.json`。

### 8.4b 阶段 N3C：CLI 入口层与 TUI 交互快赢批（P1，无依赖，可随时插队）

> 来源：zcode CLI 0.16.9 安装版实测 surface（2026-09-29，`--help`/`doctor`/官方插件缓存盘点）+ Claude Code / OpenCode 公开文档对标（§9.2）。多数为 CLI/TUI 层小活，不触碰引擎与协议；zcode surface 中 benchmark 快照未覆盖的盲区（`--json`/`--disallowed-tools`/`--target`/`--memory-bench`/`--surface`/`doctor`/`skills|commands list`）在此补录。

| ID | 项 | 验收标准 |
|---|---|---|
| N3C-1 | headless flag 组（**已落地**）：`-p/--prompt`；`--mode`（四档，headless 语义=ask 即拒，走同一 applyMode 路径）；`--json`（NDJSON 复用 SessionEvent + jsonlLine，末行 CLI 级 result 记录）；`--cwd`（chdir 先于一切 IO）；`--attach`（v1=图片并入 `--image` 管线）；`--disallowed-tools`（组装期过滤全集含 MCP/task/plan_submit，子代理继承，未知名 fail-fast）；`-c` 别名；`--` 分隔。**行为变更**：未知 flag 从静默并入提问改为报错 | 无 TTY 下 `kcode -p "..." --json --mode plan` 全链路可跑且输出可 `jq` 解析；`--disallowed-tools "write edit"` 后该次会话无此二工具 |
| N3C-2 | `doctor` 子命令（**已落地**）：Node≥22 / 配置与默认模型 / 钥匙串（DPAPI 或口令）/ 默认 key 探测（probe）/ rg 落点 / mcp.json 解析 / 会话目录可写 / 终端能力（⚠ 级） | 异常环境一命令定位；有 ✗ 退出码 1 |
| N3C-3 | 管理类子命令（**已落地**：`skills list`、`commands list`、`plugins enable/disable` + list 显示 [已停用]；停用状态 `~/.kcode/cli/plugins/state.json` 原子写，`validate/update/marketplace` 后续） | 根构造提取为 `@kcode/extensions.buildExtensionRoots` 单一事实源，会话组装与 CLI 盘点同源 |
| N3C-4 | TUI 交互补全（**①—⑦全部落地，本批收尾**）：① 状态栏常驻上下文余量/用量/git 分支；② 工具卡片逐块展开（Ctrl+B 覆盖层浏览器）；③ 后台任务面板（Ctrl+T，注册表会话级注入 + 1s 轮询 + 日志尾部）；④ Ctrl+E 外部编辑长输入（$EDITOR 回填，仅空闲）；⑤ Ctrl+V 剪贴板贴图（Windows 经 WinForms 读位图落盘 PNG，v1 仅 Windows、其他平台提示走 --image；pendingImages 状态 + 指示器，空闲提交随行、排队不消费避免静默丢失，清空在 App 守卫之后防 exit 丢图）；⑥ Ctrl+R 历史搜索覆盖层（跨会话输入历史子串过滤、Enter 回填输入框）；⑦ 欢迎横幅键位发现性两行（全部快赢键位一览） | §9.2 对应行全部达标 |

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

## 9. 功能对标清单

### 9.1 能力对标（ZCode 全量 × kcode 状态，2026-09-29 复核）

| 域 | ZCode | kcode | 缺口 |
|---|---|---|---|
| Agent 循环/流式/并行工具/后台任务 | ✅ | ✅ | 无 |
| 工具链 read/write/edit/grep/glob/bash | ✅ | ✅ | 无 |
| 子代理 | ✅ | ✅ | 消息互通 SendMessage/RespondToCoordinator（需异步子代理运行时，独立批落地） |
| Plan/结构化提问/Todo | ✅ | ✅ | 无 |
| 上下文压缩/SKILL/AGENTS.md/resume | ✅ | ✅ | 无 |
| 后台任务显式控制（task_output/task_stop） | ✅ | ✅（工具面补全落地：注册表挂子进程，stop 发信号、状态由 close 回调单一回写） | 无 |
| Skill 显式工具 | ✅ | ✅（模型按名读正文；skill_used 契约扩 trigger=tool） | 无 |
| 会话上下文回读（ReadSessionContext） | ✅ | ✅（sessions read 增 detail=full：从最近往前全文装填，8000 字符预算） | 无 |
| MCP/Hooks/斜杠命令/插件安装 | ✅ | ✅ | 加载期 hash（N3-5） |
| CLI 入口层（-p/--mode/--json/--cwd/--attach/--disallowed-tools） | ✅ | ✅（N3C-1 落地：`apps/cli/src/args.ts` + `headless.ts`） | 无 |
| doctor 自检 | ✅ | ✅（N3C-2 落地：`apps/cli/src/doctor.ts`） | 无 |
| 管理子命令（skills/commands list、plugins 生命周期） | ✅ | ✅（N3C-3 落地：list/enable/disable；`buildExtensionRoots` 单一事实源） | validate/update、marketplace（N4-1） |
| 官方插件内容（文档四件套/诊断/创建器系列） | ✅ | ❌ README 占位 | 内容生产（随 N4-1） |
| 跨进程协议/RPC | ✅ | ✅（N3-1 host stdio + lease） | 无 |
| 平台抽象 | ✅ | ✅（N2-1） | 无 |
| 共享 UI + 设计令牌 | ✅ | ✅（N1-5/N2-3） | 低（终端亮度探测待） |
| workspace 身份 | ✅ | ✅（N0-6/N1-3） | 无 |
| 架构治理（policy + knip） | ✅ | ✅（N2-5 收口 + 例外登记） | 无 |
| 发行链 | ✅ | ✅（N2-4） | 无 |
| Web 端 + 远程访问 | ✅ | ⚠️ Web + 中继已落地（N3-3） | 远程 E2E 消费者（N4-2） |
| 桌面端 | ✅ | ❌ | 高（N3-4） |
| 插件市场/商店 | ✅ | ⚠️ 装卸 | 高（N4-1） |
| 长期 Memory（zcode `--memory-bench` 自动抽取） | ✅ | ⚠️ 接口 only | 中（N4） |
| 定时调度（cron/off-peak 工具） | ✅ | ❌ 接口 only | 中（N4-5） |
| i18n / 遥测 / 电脑控制 / 浏览器控制 / 动态工作流 | ✅ | ❌/⚠️ 本地遥测 | 中（N4-3/6/7/8） |

### 9.2 CLI/TUI 交互对标（Claude Code / OpenCode / ZCode × kcode，2026-09-29）

> 依据：Claude Code 官方文档与 changelog（Esc Esc 回退菜单分"代码/对话/两者"、Tab 补全、Ctrl+R 跨项目历史搜索、`/statusline`、context left 指示等）、opencode.ai/docs/keybinds（leader/which-key、会话侧栏与 timeline、share、消息级 undo/redo、外部编辑器、emacs 全键位输入区）、ZCode benchmark §1.7/§2；kcode 列为代码实测。本表即 N3C-4 的差距全景。

| 交互项 | Claude Code | OpenCode | ZCode | kcode | 动作 |
|---|---|---|---|---|---|
| 工具卡片逐块展开/折叠 | ✅ | ✅ | ✅ | ✅（N3C-4②：Ctrl+B 浏览器，↑↓/Enter 交互，覆盖层避开 Static 不重绘约束） | 已达标 |
| 上下文余量/成本常驻状态栏 | ✅（context left） | ✅（status view） | ✅ | ✅（N3C-4①：ctx %·k 值 + ⇅ 双向 token + >85% 警示色） | 已达标 |
| git 分支/工作区状态注入 | ✅（statusline） | ✅ | ✅（git snapshot） | ✅（N3C-4①：⎇ 分支段，60s 采样） | 已达标 |
| 可定制 statusline（脚本注入） | ✅（/statusline） | ⚠️ | ✅ tokens | ❌ | 后置评估 |
| 外部编辑器（$EDITOR 长输入/计划） | ✅（Ctrl+G 计划） | ✅（leader+e） | ✅ | ✅（N3C-4④：Ctrl+E，空闲态编辑当前输入并回填） | 计划编辑后批 |
| 剪贴板图片粘贴 | ✅ | ✅ | ✅ | ✅（N3C-4⑤：Ctrl+V 贴图为附件随消息发送；v1 仅 Windows） | 已达标（平台覆盖后续） |
| Tab 路径/斜杠参数补全 | ✅ | ✅ | ✅ | ⚠️ @ 补全有；Tab 路径与命令参数提示无 | 小项 |
| 跨会话历史搜索 | ✅（Ctrl+R） | ⚠️ | ✅ | ✅（N3C-4⑥：Ctrl+R 覆盖层，子串过滤 + Enter 回填） | 已达标 |
| Esc Esc 回退（代码/对话/两者分粒度） | ✅ | ✅（revert/fork 消息级） | ✅ | ⚠️ rewind picker 有；粒度未分 | 小项 |
| 后台任务浏览面板 | ✅ | ⚠️ | ✅ | ✅（N3C-4③：Ctrl+T 面板，1s 轮询 + 日志尾部） | 已达标 |
| 子代理进度卡（代理名/活动态/层级导航） | ✅ | ✅（parent/child 导航） | ✅ | ⚠️ 仅工具状态行 | 随消息互通一起做 |
| 会话侧栏/timeline/分享链接 | ⚠️（/resume picker） | ✅（sidebar+timeline+share） | ✅ | ⚠️ resume picker；share 无 | share 属 N4-2 |
| 消息/输入级 undo-redo | ⚠️ | ✅（leader+u/r + 输入 undo） | ✅ | ❌ | 小项 |
| leader/命令面板（动作可发现性） | ⚠️（IDE 侧） | ✅（leader+ctrl+p） | ✅ | ⚠️ OptionsMenu 有；无统一面板 | 后置评估 |
| 空态欢迎/建议/提示 | ✅ | ✅ | ✅ | ✅（N3C-4⑦：横幅两行键位一览；建议提示词后续可加） | 已达标 |
| 技能触发透明（回显加载来源） | ✅ | ✅ | ✅ | ✅（skill_used 回显"自动/手动"） | 已达标 |
| 思考流独立层 | ✅ | ✅ | ✅ | ✅（思考行 + Ctrl+O 展开） | 已达标 |
| Todo 实时面板 | ✅ | ✅ | ✅ | ✅ | 已达标 |
| 技能 frontmatter `allowed-tools`/`disable-model-invocation` | ✅ | — | ✅ | ❌ | benchmark §1.15 既列，N2 补 |
| `#` 快捷追加记忆文件 | ✅ | ⚠️ | ✅ | ❌（AGENTS.md 已加载，无快捷追加入口） | 小项 |

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

### v5（2026-09-29）

- **工具面补全落地（第五批）**：① `task_output`/`task_stop`（对标 zcode TaskOutput/TaskStop）——`BackgroundTaskRegistry` 增子进程引用（`attach` 挂 track 后的 child、close 自摘、`stop` 发终止信号；Windows 不追杀孙进程——与前台超时同边界）；状态翻转仍由 close 回调单一回写（stop 只发信号，无双写）；权限：task_output 只读放行，task_stop 默认询问/plan 档拒绝。② `skill` 显式工具——技能正文第三条加载通道（自动触发 / 手动 /skill 之外，模型按名读取）；描述内联当前可用技能名；`skill_used` 契约 trigger 扩 `"tool"`（读旧文件兼容），TUI 回显"模型调用"。③ sessions read 增 `detail=full`（ReadSessionContext 语义）——从最近往前全文装填、8000 字符预算、超限标注省略条数（续接场景要的是会话末端完整状态）；summary 浓缩模式保持默认。**SendMessage 评估结论**：需要异步子代理运行时（子代理后台化 + task-notification 事件 + 消息路由），是架构级改动而非工具增补——独立批落地，不塞进工具面小步节奏。测试 +9（task-tools 3 含真实启动/终止链路；skill-tool 2；sessions-read 4 含超预算截断）。
- **N3C-4⑤⑥⑦ 落地（第四批快赢，N3C-4 全部收尾）**：⑤ Ctrl+V 剪贴板贴图——终端不传图片数据，`clipboard-image.ts` 经 PowerShell WinForms（-STA）读剪贴板位图落盘 PNG（v1 仅 Windows，其他平台提示走 `--image`）；`pendingImages` 入共享 slice（去重增删清），输入区上方指示器；空闲提交随消息发送（`runDispatch` 增 images 参数、普通提问路径消费、斜杠路径不消费），排队不消费附件、清空时机在 App.submit 守卫之后（exit/空输入不丢已贴图）。⑥ Ctrl+R 历史搜索覆盖层——`HistorySearch.tsx` 自持键位（字符/退障编辑查询、↑↓ 选择、Enter 回填 App setInput、Esc 关闭），跨会话输入历史（~/.kcode/cli/history.json 最近 50 条）子串过滤最近优先；keybinds 层让行守卫覆盖三种覆盖层。⑦ 欢迎横幅键位发现性两行（Ctrl+O/B/T/E/V/R + /help 全览）。测试 +6（input-extras：slice 1/贴图与随行 1/历史搜索 1/横幅 1/Windows 真实剪贴板往返 1（WinForms 置图→读 PNG 魔数，无剪贴板服务环境自动跳过）/非 Windows 降级 1）。
- **N3C-4③④ 落地（第三批快赢）**：③ 后台任务面板——`BackgroundTaskRegistry` 从 `createBashTool` 内部提升为 composition 创建并经 `BashToolOptions.registry` 注入（会话级单一事实，`ComposedSession/SessionHandle.backgroundTasks()` 透出）；`Ctrl+T` 覆层面板（打开期间 1s 轮询快照 + 展开时异步读日志尾部 40 行），与工具浏览器互斥、同一键位模式（↑↓/Enter/Esc，Ctrl+B/Ctrl+T 互为切换）；ui 层新增 `BgTaskView` 视图类型（不引 tools 包，守住分层）。④ Ctrl+E 外部编辑长输入——`external-editor.ts`（$EDITOR 临时文件回填，未设时 notepad/vi 兜底，空文件=放弃保持原输入）；键位放 InputArea（需要输入值与回填通道），仅空闲可用（spawnSync 阻塞事件循环，运行中会冻结流式渲染——代码注释已注明约束）；失败路径保证 raw mode 恢复。测试 +8（bash 注册表注入 1；task-browser 7：slice 2/渲染 2/键位互斥 1/编辑器 2 含真实 Ctrl+E→假编辑器→回填链路）。
- **N3C-4② + N3-5 落地（第二批快赢）**：① 工具卡片逐块展开——覆盖层浏览器形态（Static 架构下已完成的块不再重绘，原地展开不可行）；`packages/ui` transcript slice 增 `ToolBrowserState`（open/cursor/expandedCallId，clamp 与切换语义在 slice）；键位统一 `keybinds.ts`（Ctrl+B 开关、↑↓ 移动、Enter 展开、Esc 关闭并让行其余键位层）；面板 `ToolBrowser.tsx` 纯渲染（10 行窗口 + 40 行详情上限）；`InputArea.tsx` 抽离 App 的输入区三态装配（浏览器打开顶替输入框，方向键无第二消费者——App.tsx 反降至 494 行）；② 插件加载期 hash 校验——`hashDirectory` 支持排除项（seed 自身：安装是"先算哈希后写 seed"，计入则永假）、`verifyPluginSeed` 导出、`buildExtensionRoots` 校验失败拒绝装载 + onWarn（会话组装与 CLI 盘点同点收口）、`plugin list` 显示 ⚠。测试 +9（tool-browser 7：slice 4/渲染 2/键位链路 1；plugins 校验 2）。§2.3 仍开放缺陷收敛为 2 条；§7 B5 与已知边界同步（诚实注记：加载期校验防"装后被改"，不防"装时即恶"——后者属 N4-4 签名）。
- **N3C 快赢批落地（N3C-1/2/3 + N3C-4①）**：① `apps/cli/src/args.ts` 纯函数解析器（-p/--mode/--json/--cwd/--attach/--disallowed-tools/-c/--，未知 flag 由静默并入提问收紧为报错）+ `headless.ts` 无 TUI 运行路径（NDJSON 复用 SessionEvent+jsonlLine，末行 CLI 级 result 记录，退出码 0/1/130）+ `doctor.ts` 八项自检（✗ 即 exit 1）+ `inspect.ts` 盘点（skills/commands list）+ plugin enable/disable（`state.json` 原子写，list 标注 [已停用]）；② 单一事实源——根构造提取为 `@kcode/extensions.buildExtensionRoots`，`packages/session` 组装与 CLI 盘点共用，停用过滤同点生效；③ `ComposeSessionOptions` 增 `initialMode`（与 /mode 同一 applyMode 路径）与 `disallowedTools`（全集 fail-fast + 子代理继承）；④ TUI 状态栏常驻（`packages/ui` run-status slice 增 `UsageStats`；`tui/state/status-data.ts` busy 收尾沿刷新 + git 分支 60s 采样；StatusBar 三段渲染 >85% 警示色）。测试 +38（args 10/doctor 4/inspect 3/headless 3/statusbar 5/plugins-state+roots 6/session-options 5 全绿，全套 76 文件 369 用例通过）；行数治理：composition.ts 497→473（`resume.ts` 外迁续接/信任工具），App.tsx 498/500 压线（status-data 模块化）。工具名澄清：kcode 工具名为小写（write/edit 非 Write/Edit）。
- 对标复核与盲区补录：以 zcode CLI 0.16.9 安装版实测 surface（`--help`/`doctor`/官方插件缓存）+ Claude Code / OpenCode 公开文档复核；§1.4 新增补录口径；§9 重构为 9.1 能力对标（刷新 N2/N3 已落地行的过时状态，新增 CLI 入口层、doctor、管理子命令、官方插件内容、长期 Memory、定时调度六行）+ 9.2 TUI 交互对标（20 行全景，kcode 列经代码实测：思考流/Todo 面板/技能触发回显已达标；逐卡展开/外部编辑器/剪贴板粘贴/历史搜索等确认缺失）。
- 状态修正：头部状态行 v2 滞留修正为 v5；§0 一页总结与路线图示意刷新至 N3 中期实况；§2.3 已知缺陷复核——`/compact` 落盘（compact-persistence.test.ts 锁定）、压缩按完整轮次切片（compact.ts 含 covered/taskAnchor）、检查点持久化（N0-4）、workspace 身份（N0-6/N1-3）、治理门禁（N2-5）、发行链（N2-4）均已收口移出，仍开放项收敛为 3 条（插件加载期 hash、技能来源策略、contracts 零消费者）。

### v4（2026-09-28）

- N1 收口：knip 挂上 CI（ci.yml）；oxlint 挂 `no-console: error`（§8.2 N1-4 机器化），`main.tsx` 的 console 全部改为显式 `print`/`printErr` 出口；N1-4 logger 落点由 `packages/ui`（N2-3 才立包）改为 `packages/shared`，§8.2 行同步。
- N2 口径统一与机制补强（对标 ZCode 两处耐久机制）：N2-2 定为简化版 `RuntimeCommandQueue`，owner/lease 随 host 进程挪至 N3-1（kill -9 验收随迁）；N2-3 补服务注入模式（`ServicesProvider`/`useServices` + Zustand slice，先定后拆）并纳入 `ToolEntry` 工具契约；N2-5 补例外登记制 `gates-exceptions.json`（例外带到期日，过期即 CI fail）。
- N2-1 落地：`contracts.IPlatformService`（keychain 端口 + 平台事实，按实际使用面裁剪）+ `platform.createPlatformService` 工厂；`Runtime.platform` 注入，`main.tsx`/`tui/App.tsx` 去 `@kcode/platform` 直接依赖（login 向导、key 子命令、启动口令校验全走端口）；depcruise 新增规则5 `ui-no-platform-impl` 机器校验。
- N2-2 落地：`packages/runtime` 新增 `RuntimeCommandQueue`（now/next/later 稳定排序 + `tryReserve` 单 reservation + `clear` 绑定中断语义）；`ComposedSession.commandQueue` 暴露 + `onQueueChange` 镜像；CLI 接线——busy 提交入队（含历史记录与输入清空）、完成即排空（`runOccupied` 四路径统一）、Esc/Ctrl+C 清空排队、busy 行显示排队数、输入区常驻（原"运行中隐藏输入区"的旧契约随排队的引入废除）。
- N2-3 落地（拆分/立包/注入/门禁；`ToolEntry` 收尾项另计）：`packages/ui` 立包——`services/`（`ServicesProvider`/`useServices` React Context，DOM-free）+ `state/`（zustand 双 slice：run-status + transcript，工厂隔离实例；`Block` 视图模型上升为跨端语义格式）；App.tsx 2078→484 行，拆为 theme/terminal/transcript/input/dialogs/status/state 七目录（dispatch→`input/commands.ts`、面板→`dialogs/DialogLayer.tsx`、按键→`terminal/keybinds.ts`、生命周期/事件/交互→`state/`）；App 状态迁移 zustand（busy/转写/排队镜像，同步判定走 `getState` 替代 busyRef）；LoginWizardPanel 经 `useServices` 取 `IPlatformService`（注入层首个真实消费者）；oxlint `max-lines: error 500` 覆盖 `tui/**`（存量超限 core/loop.ts 581、composition.ts 553 随 N2-5 全仓启用时清零）。
- N2-5 落地（门禁成真门禁，N2 收官）：① 规则4 `apps-import-packages` 升 error——语义从"warn 监控"改为"app 只准经包的公开入口 `src/index.ts` import，深路径（包内部文件）禁止"，零例外零警告；② `max-lines: error 500` 全仓启用（oxlint 规则层），`core/loop.ts` 581→495（executor 外迁 + 审计翻译器入 pipeline + `runCompaction` 入 compact）、`composition.ts` 553→495（rewind/prompt/user-bash 各自外迁）；③ 例外登记制 `gates-exceptions.json`（5 条 no-console 例外：理由+到期日，期限上限一季度）+ `pnpm gates:check`（schema/过期/漂移三重校验，oxlint overrides 与登记集合强制一致）挂 CI。至此 N2 五项全部落地。
- N3 设计修订（进 N3 前对照 ZCode/Claude Code 审定的六条，落实为 §8.4 注 A–F + §3.5 补条）：A 排空权威移入 host + 前端 SessionProxy（N2-2/2-3 同步假设在进程边界的修正）；B lease 机制具体化（host 重启即 logEpoch+1 + 悬空租约检测 + commandId 幂等/baseRevision CAS）；C 协议词汇表（method/event 清单、ask 断连 fail-closed deny、reasoning 合帧在 host 侧）；D host 粒度拍板（每会话一进程，不做 host 内多会话）；E IPlatformService 按进程拆两半（host 完整 keychain，前端只剩 probe/saveKey-RPC）；F Electron 形态定死（utilityProcess.fork 每窗口 + MessageChannelMain，stdout 只跑 RPC）。审定结论：骨架不变——Web 安全模型已强于 ZCode（TLS 强制+令牌默认）保持不回撤；事件重放语义与 web-remote-replayable 吻合无需改。
- N3-1 落地（宿主进程 + stdio 协议 + lease）：① `contracts/host-protocol.ts` 词汇表（ClientFrame/HostFrame JSON-Line 信封 + HostEvent 联合 + SessionCreate/Submit/AskRespond 等参数 schema）+ `session.ts` 新增 `host_lease` 事件（epoch/pid/hostId）；② `apps/host` 三模块——`boot.ts` 装配（keychain/router 不出宿主，注 E）、`server.ts` 方法路由 + commandId 幂等缓存、`session.ts` 会话生命周期（排空权威在宿主注 A；lease 接管检查注 B：前持有者 pid 活 → 拒绝；ask 10s 超时 fail-closed deny 注 C；reasoning 250ms 合帧注 C）；③ `packages/runtime/src/host/client.ts` HostClient（spawn + JSON-Line 双向 + request id 关联 + waitFor 事件谓词 + kill/close）；④ 集成测试 4 例全绿（真实子进程 spawn）：握手→创建→提交→事件流+JSONL 落盘、kill -9→新宿主接管 lease epoch+1 + JSONL 无幽灵写回、双活拒绝（pid 存活→create 报错）、断连 fail-closed。测试用 LLM 指向不可达端点（127.0.0.1:9）——协议机制验证不需要真实 LLM。
- N3-2 落地（凭证边界收敛）：① `contracts/platform.ts` 新增 `PlatformClientPort`（secureStorageAvailable + probe + saveKey 三方法）与 `platformClientAdapter()`（将宿主侧 IPlatformService 适配为前端端口——单进程模式下本地实现，进程边界后换 RPC 代理组件不改）；② `CliServices.platform` 类型从 `IPlatformService` 改为 `PlatformClientPort`——Login 向导只调 `saveKey(ref, key, audiences, passphrase?)`，不再直调 `openPassphraseKeychain/openSecureKeychain`（key 明文不出宿主进程，注 E 达成）；③ 宿主协议新增 `platform/probe {ref}→{available}` 与 `platform/save_key {ref,key,audiences,passphrase?}` 方法，宿主侧实现持有完整 keychain（`apps/host/src/platform.ts`）；④ CLI App.tsx 渲染树经 `platformClientAdapter(props.runtime.platform)` 注入——前端组件从类型层面就拿不到 open*Keychain。
- N3-3 完善（Web 客户端功能补齐）：① 设计令牌——`@kcode/design/src/web.ts` 新增 `WEB_CSS_VARS/WEB_LIGHT/WEB_DARK/webCssTheme()`（13 语义色 → CSS 变量 + 亮暗自动切换），`main.tsx` 启动时注入——与终端 ANSI 映射同源（N1-5 的两端出口）；② 交互面板三件套——`Dialogs.tsx` 审批（四选：允许/本会话/本项目/拒绝）+ 计划批准（批准并执行/继续研究/放弃）+ 结构化提问（多选+选项描述），与 CLI 的 OptionsMenu 同语义；③ 会话管理栏 `SessionBar.tsx`——模式循环切换（四档颜色区分）+ 中断按钮（运行中出现）+ 会话列表（sessions/list RPC）+ 续接；④ 斜杠命令——/mode（四档+循环） /clear（新会话） /compact /context /cost /status /resume /help + !命令直执行；⑤ Markdown 渲染 `Markdown.tsx`——代码块（带语言标签+背景）+ 行内代码 + 粗体 + 链接 + 列表（零外部库 ~120 行），assistant 与流式文本均走 Markdown。
- N2-4 落地（发行链）：tsup 全量 bundle（esbuild 单文件 kcode.mjs ~7.3MB，workspace 包与 npm 依赖全部打入；例外：canvas 运行时按需、react-devtools-core 桩替换、yoga.wasm 平铺产物旁、@vscode/ripgrep 外部化 + rg 二进制定位与自建最小包随包分发）；`--version` 短出口（构建 define 注入版本）；`pnpm release` = 构建 → tar.gz → sha256 → latest.json（版本 0.1.0 起步；latest.json 记录 platform/arch，rg 为构建机平台——跨平台需在目标平台构建）；install.sh（POSIX）/install.ps1（Windows）双端安装器（本地包或 URL、sha256 校验、解包 ~/.kcode/releases、current 指针 + ~/.kcode/bin 启动器）。验收：干净目录解包独立运行 + key 子命令（DPAPI）+ 一次性提问真实 LLM 任务全通过。教训记录：pnpm 11 的安装脚本白名单键是 `allowBuilds`（pnpm-workspace.yaml）；误改成 `onlyBuiltDependencies` 会引发 ERR_PNPM_IGNORED_BUILDS 连锁失败（verify-deps-before-run 把 install 失败传染给所有脚本）。
- N2 实现审计修正（对照 ZCode/Claude Code 的偏差清理）：① 修复换会话排队悬挂——/clear、/resume 换建会话前清空旧队列（旧队列残留项无人排空且排队计数停在旧值），测试锁定；② bash 安全命令直跑——`safe-commands.ts` 白名单门（含控制结构/危险旗标/git 子命令收紧），default/acceptEdits 档 `ls/git status/grep` 类免确认、plan 档仍全拒；③ 注入补全——`CliServices`（platform/ui/getSession/dialogs 动作包）经 ServicesProvider 一次注入，DialogLayer 28 props → 10 状态 props，面板组件不再经 props 透传回调；④ Shift+Enter 换行（kitty/modifyOtherKeys 终端可区分，可移植路径仍 Ctrl+J/行尾反斜杠）；⑤ bash/grep 声明 resultBudget 4096（ToolEntry 首批真实数据消费）。
- ToolEntry 落地（N2-3 收口）：`ToolDefinition` 扩展 `permission`（三档声明：default 必填，plan 缺省按 readOnly 推导，acceptEdits 缺省同 default；fullAccess 恒 allow）+ `timeoutMs`（管线结算护栏，超时按失败结算不挂死会话）+ `resultBudget`（结果回灌历史的按工具 token 预算，JSONL 仍全文）；权限裁决从四份按工具名维护的模式名单改为 `ModePermissionEngine` 声明驱动（未声明的 MCP/插件按 `MODE_FALLBACK` 回退：plan deny / default+acceptEdits ask / fullAccess allow）；14 个内置工具全部声明（读类 allow、write/edit 在 acceptEdits 放行、bash 恒 ask，超时 30s~600s 分级）；会话级放行/项目持久放行经 `MutablePermissionEngine` 叠加不变。

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

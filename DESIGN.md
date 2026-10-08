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
             → N3 通道扩展（host ✅ · 凭证边界 ✅ · Web/中继 ✅ · Desktop 待 · 插件 hash ✅）→ N4 生态与云（市场/账户/调度/电脑控制）
             ↘ N3C CLI 入口层/TUI 交互快赢批 ✅（①–⑦ 全落地）
             ↘ N3D 子代理异步化与消息互通（两期，§8.4c：一期后台+通知+落盘+并行组 ~1.5 周；二期 TurnPhase 前置+steer+SendMessage 1.5-2.5 周）
             ↘ N3E 执行层体验批 ✅（§8.4d：bash 三段预算/cd 项目边界/配置覆盖层/kcode update/凭证指纹回退/idle 微压缩，6/6）
             ↘ N3F/G/H CLI 体验三期（§8.4e：终端打磨 ✅ 8/8 → 输入补全 ✅ 4/4 → 深度交互 H 后排）
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
| ADR-11 | 更新链完整性：**sha256+https 为基线（zcode 实测同级，其并无 TUF——`releaseDownload.ts:137` 仅哈希+尺寸校验）**；插件签名 Sigstore keyless（N4-4）；TUF 角色分离降为自设可选增强 | 基线即可防传输损坏与配置错；CI 钥匙泄露的轮换诉求由 N4-4 签名解决 |
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

**已知边界（诚实声明）**：提示注入未解；无 OS 级沙箱（"工具执行前确认"≠沙箱）；凭据与代码同进程；插件 seed 本身可被连同内容一起重算伪造（防伪需 N4-4 签名，加载期校验防的是"装后被改"而非"装时即恶"）；技能自动注入不区分来源；BYOK 远端调用意味着源码会离开本机；**Static 转写不可逆约束**（已打印块推进 scrollback 后不再重绘——原地编辑消息/内联进度卡类交互永远只能覆盖层实现，§8.4b②的架构代价）；**子代理结论信任链**（结论作为 tool_result 无审查回灌父上下文，子代理读过不可信网页后其结论可携带注入文本——post_tool_use hook 是唯一校验点，与 zcode 同级）。

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

### 8.4c 阶段 N3D：子代理异步化与消息互通（P1–P2，两期；对标 zcode 异步子代理体系）

> 2026-09-29 对 zcode 源码（本地克隆，提交 `29628c9`）复核后的设计修订：原 benchmark §1.5"采纳消息互通"在此具体化为 zcode 式目标形态——子代理可后台运行、完成经**命令队列**通知注入父上下文、子会话**独立落盘**、SendMessage **三态投递**（steer/排队/复活）。
> 分两期的依据：一期的积木 kcode 全部已有（N2-2 RuntimeCommandQueue / N3C-4③ BackgroundTaskRegistry / JsonlSessionSink）；二期的 steer 需要 AgentLoop 增加步边界 drain 钩子（动 core 循环），是全批最重的单点。
> zcode 引用（`file:line`）指向其本地克隆仓库。

| ID | 项 | 依赖 | 设计要点（zcode 机制 → kcode 落点） | 量级 |
|---|---|---|---|---|
| N3D-1 | 后台子代理 + 完成通知 + 子会话落盘 + ask_user 透传（**已落地**，含增补⑨并行组/⑩看门狗） | N3C-4③ | 验收：`task wait:"background"` 立即回执 → task_output 查活动/task_stop 终止 → 完成通知注入父上下文（防伪头 + 幂等 + Esc 连杀）；子会话落 `sessions/subagents/`；同批多 task fan-out 并发 | ✅ 测试锁定（subagent-background/executor-groups） |
| N3D-2 | SendMessage 两态投递 + RespondToCoordinator + steer（**已落地**；设计修订：zcode 三态在 kcode 简化为两态——无"空闲存活"态，终态同 loop 新 run 即复活，优于 resumeFromStore） | N3D-1 + **前置：TurnPhase 显式化（已落地）** | **前置任务已落地**：`packages/core/turn-state.ts` 八态机（zcode 十态裁剪——kcode 无独立 AwaitingModelResponse/权限等待在 ExecutingTools 内）+ `TURN_TRANSITIONS` 合法迁移表 + `transition()` 唯一强制点（非法即抛）+ `finish()` 幂等归位；loop.ts 十处位点推进（输入/流式/调度/执行/聚合/错误/收尾），`onPhase` 观察缝（测试断言与未来 steer 判定）；consumeStream 抽出独立模块（行数治理，loop 477 行）。**steer 状态将独立成层**不塞进 phase（zcode 教训：drain 合法性独立判定不读 TurnPhase）。主体：① 收件人运行中 → steer 拼进当前请求 ② 收件人空闲 → 注册表 `pendingMessages` 排队冲刷 ③ 收件人终态 → 消息作为新 prompt 经 resume 复活（依赖 N3D-1 落盘 + 既有 `resolveResumeHistory`）④ RespondToCoordinator **无条件注入**子代理工具面、异步单向入队（子不等待回复）⑤ 入站消息统一 system-reminder 包装 + 防伪头；⑥ SendMessage 非阻塞、只回 queued/steered/resumed 三态回执 | 1.5–2.5 周 |

**明确不抄**（zcode 为多端平台付的税，与"子代理最小集"原则一致）：profile 系统（351 行）、持久通知账本（kcode 的 JSONL append-only 本身就是账本）、`branchGeneration` 回退代际、闲时轮拒发、镜像 toolCallId 重写（v1 用 spawned/stopped 事件 + task_output 查详情替代）。

### 8.4d 阶段 N3E：执行层体验批（P1–P2，2026-09-29 审计产出；对标 zcode adapters/exec + config + 更新链）

> 来源：全量对标审计发现的"无票遗漏"（benchmark 承诺过采纳但未排期，或审计新发现）。zcode 引用（file:line）指向其本地克隆。

| ID | 项 | zcode 机制（file:line） | kcode 落点 | 量级 |
|---|---|---|---|---|
| N3E-1 | bash 三段预算输出（**已落地**：OutputCollector 内联 30k/全文落盘 artifacts/尾部 2k，内存硬顶 1M 保头尾诚实注记；与 loop 层 capToolResult 职责分离） | OutputCollector 三预算（bash 内联 30k 字节/落盘/4KB tail；on_truncate 激活时**回放已缓存内联块**保证落盘完整；`output-collector.ts:51-138`） | `bash.ts` 的 64k 一刀切改为：内联 30k 字符 + 溢出全文落 `<artifactsDir>/<callId>.log` + 尾部 2k 与 artifact 路径随结果返回；与 loop 层 `capToolResult` 职责分离（bash 层保全文不丢，loop 层管回灌预算） | 2 天 |
| N3E-2 | cd 持久的项目边界（**已落地**：越界重置回会话目录并在输出中告知模型） | `decideBashCwdPolicy`：持久目录仅项目内保留，越界重置回 workspace root（`bash-cwd-policy.ts:36`） | `bash.ts` 的 `lastCwd` 加边界判定（必须在 ctx.cwd 子树内）——修复"cd 出项目后持久滞留" | 0.5 天 |
| N3E-3 | 配置 Env/Project 覆盖层（**已落地**：用户级 providers 唯一 → Project 仅 default → Env 白名单 KCODE_DEFAULT_MODEL；项目 providers 投毒被忽略） | 五级优先级数值 + **一层浅 spread 非递归深合并** + Env 白名单逐项硬编码（`config-merger.ts:26`、`env-config.adapter.ts:14`） | 补 Env 白名单（KCODE_TIMEOUT_MS/KCODE_MAX_TOOL_CONCURRENCY/代理类）与 Project 层 `.kcode/config.json`（**仅非 provider 字段**：defaultModel 覆盖、features 开关）；providers 锁死用户级不动（kcode 比 zcode 更强的安全边界，不为对齐放弃）；CLI 层（--mode/--disallowed-tools）已有 | 2–3 天 |
| N3E-4 | `kcode update` 自更新（**已落地**：latest.json URL/本地通道，size+sha256 校验，staging 原子换名，翻 current Junction；win32 显式 System32 bsdtar——GNU tar 把 C: 当远程主机） | zcode 实测**无 TUF**——catalog+semver+SHA-256/尺寸校验+part 临时文件原子落位+pending/current 指针（`releaseDownload.ts:137`），~1,300 行 | kcode 发行链（N2-4）已有 tar.gz+sha256+latest.json+releases+current 指针，只差消费方：`kcode update` 子命令复用安装器逻辑下载校验翻指针，~300 行；sha256+https 即 zcode 同级 | 2 天 |
| N3E-5 | 凭证机器指纹回退（**已落地**：口令 > DPAPI > 指纹三级；原"禁止机器 ID 派生"原则修正为显式降级层+文档声明） | `ZCODE_CREDENTIAL_SECRET` 未设时回退指纹 `盐:platform:homedir:username`→sha256→AES-GCM（`credential-cipher.ts:87-101`） | 非 Windows 且未设口令时同款指纹回退（Windows 已有 DPAPI）；威胁模型写入 threat-model：指纹是"防误提交"级（同机可推导），非防本地恶意用户——与 zcode 同级诚实 | 1 天 |
| N3E-6 | idle 微压缩（**已落地**：空闲超 60min 下一次输入先走 persistedCompact；阈值可注入测试） | 挂机 >60min 触发微压缩（zcode 后台定时） | kcode 单进程不必后台定时：**下一次用户输入时**检查距上次活动超 60min 即触发压缩——语义等价成本更低 | 0.5 天 |

### 8.4e 阶段 N3F/G/H：CLI 体验三期（2026-09-29 对标审计产出；zcode 引用指向本地克隆，CC=Claude Code / OC=opencode 按公开行为对标）

> 审计口径：只列**未落地**项；已交付的 N3C①–⑦/N3D/N3E 不重复。每项给机制、落点、对标依据与取舍；量级小计 F≈1 周 / G≈1 周 / H≈1.5–2 周（H 后排至 N3-4 之后）。

**N3F 终端打磨批（先做——低成本高感知 + CLI 基本面收口）**

| ID | 项 | 设计要点（机制 → 落点 → 对标 → 取舍） | 量级 |
|---|---|---|---|
| N3F-1 | OSC 8 可点击链接（**一期只做结构化链接**——复审修订；**已落地**：`tui/terminal/links.ts` + truncateVisual 链接感知） | 机制：`\x1b]8;;file:///<abs>#L<line>\x1b\\<label>\x1b]8;;\x1b\\` 零宽序列包裹。**一期只覆盖结构性位置**（路径是已知值零误报）：工具 argsPreview、bash 三段预算 artifact 路径、task_output 日志路径、检查点/子代理会话路径——CC/OC 的链接同样来自结构位而非文本扫描。二期（可选）才扩展 assistant 正文，且**仅限 Markdown code span 内**（markdownToLines 已产出 span 边界，检测面缩 95%；全文正则扫路径的误报——版本号/URL/盘符——是 CC/OC 都不走的死路）。**两个坑**：① `truncateVisual` 可能切掉 OSC8 闭合序列造成悬空链接——截断必须链接感知（先截 label 再包序列）；② Ink 宽度计量 POC 先行（宽度回归测试再铺开）。**支持面诚实化**：`file://` 点了开编辑器仅 VS Code 集成终端成立（iTerm2/WezTerm 走系统默认应用），独立 WT 会丢给浏览器——默认仅 `TERM_PROGRAM=vscode` 等已知良好终端发射，其余 `KCODE_LINKS=1` 手动开 | 1 天（含 POC） |
| N3F-2 | 终端标题栏进度（**已落地**：`tui/terminal/title.ts`，KCODE_TITLE=0 门） | 机制：OSC 0 `\x1b]0;kcode ⏳ <activity>\x07`；busy 或 activityLabel 变化时写，空闲/卸载复位为 `kcode`。落点：新建 `tui/terminal/title.ts`（写序列 + isTTY 门 + KCODE_TITLE=0 门），App 挂一行 effect（逻辑全在模块——App 行数红线）。对标：CC 同款。取舍：终端不自动还原标题，卸载时复位常量即可 | 0.5 天 |
| N3F-3 | 任务完成 bell（**已落地**：`tui/terminal/notify.ts`，KCODE_BELL=0 门；后台完成同触发、respond 中间消息不响） | 机制：busy 下降沿且本轮耗时 >10s → 写 `\a` 一次；后台完成通知同触发。落点：`tui/terminal/notify.ts`（bell + 耗时判定 + KCODE_BELL=0 门）。对标：CC hooks 通知/bell 同语义。取舍：不做系统级通知（OS 通知属 N4 桌面） | 0.5 天 |
| N3F-4 | respond 通知显示瑕疵修复（**已落地**：载荷统一防伪头，常量移 agent-messaging 防循环引用） | 机制：`buildRespondToCoordinatorTool` 的 notify 载荷统一加 `SUBAGENT_NOTIFICATION_HEADER` 前缀（与完成通知同头）→ TUI 既有 📩 分支直接命中，XML 载荷随头之后。对标：zcode 入站消息统一防伪头（`incoming-message.ts:9`）。取舍：改载荷而非改 TUI 分支——单一事实源 | 10 分钟 |
| N3F-5 | `--model <provider/model>` 旗标（**已落地**：第四层覆盖，contracts isModelRef 同源校验+provider fail-fast） | 机制：args.ts 增旗标；main.tsx 覆盖 `modelRef`（contracts modelRef 格式校验 + provider 存在性检查，未知 provider fail-fast 列可用清单）；TUI 与 headless 同一生效点。对标：CC `--model`。取舍：不另建配置层——这是 N3E-3 三层之上的第四层（CLI 覆盖，优先级最高），与 zcode `ConfigScope.Cli=50` 同位 | 0.5 天 |
| N3F-6 | `kcode mcp` 子命令（**已落地**：`mcp-cmd.ts` list/add/remove/test，tmp+rename 原子写，损坏文件拒覆盖） | 机制：`list`（名称/transport）/ `add <name> -- <stdio 命令>` 或 `add <name> <url> --transport http` / `remove <name>` / `test <name>`（单服务器连接探针，复用 `connectMcpServers` + 10s 超时）。落点：新 `apps/cli/src/mcp-cmd.ts`（镜像 doctor.ts 的 print/exit 约定）；写 `~/.kcode/mcp.json` 前 zod 校验 + tmp/rename 原子写。对标：CC `claude mcp add/list/remove`。取舍：不做 add-json（手改文件仍是逃生门）。**复审注**：项目级 MCP 配置（zcode 五级含 mcp.servers、CC --scope project）是已知缺口——但项目 mcp.json 能注入"启动即执行"的 stdio 命令，**实作前提是 /trust 门控**（同 hooks 项目级），排 N3H 之后 | 1.5–2 天 |
| N3F-7 | headless 流式文本（**已落地**：DeltaWriter 64B/50ms 微缓冲，流式收尾不重复摘要） | 机制：`-p` 非 `--json` 时 onDelta 直写 stdout，50ms/64 字符合帧（防逐 token 系统调用抖动）；流式模式末尾换行收尾不重复摘要。落点：headless.ts 增 onDelta 通道 + 微缓冲。对标：CC `--print` 流式 | 1 天 |

| N3F-8 | 搜索后端可配置（**已落地**：KCODE_SEARCH=duckduckgo|searxng|none + KCODE_SEARXNG_URL；none 不注册工具） | 机制：web_search 现硬编码 DDG HTML 抓取；Env 白名单加 `KCODE_SEARCH`（duckduckgo|searxng|none）+ searxng 实例 URL 参数。对标：CC 服务端搜索（kcode 保持本地免 key 优先）。取舍：不做 API-key 搜索引擎（需要者可自配 MCP） | 0.5 天 |

**N3G 输入补全批（Tab 补全单独立批——要动 InputBox 补全状态机，值得专注）**

| ID | 项 | 设计要点 | 量级 |
|---|---|---|---|
| N3G-1 | Tab 路径/命令参数补全（**已落地**：Tab 三态判定 + completePath 泛化；@ 优先；参数提示展示不插入） | 机制：按光标左侧 token 三态判定——① 路径形态（含 /或\ 或 `./`）→ 路径补全菜单：`file-complete.ts` 泛化为 `complete(prefix, cwd)`（去 @ 前缀强绑定，评分排序复用）；② 斜杠命令参数位 → 提示菜单：`CommandInfo` 增 `argsHint?: string`（内置命令逐个补文案；自定义命令显示 $ARGUMENTS 模板说明），展示不插入；③ 菜单内 Tab=选中（既有）。落点：InputBox 按键分支 + file-complete 泛化 + builtin-commands 加字段。对标：CC Tab 全场景 / OC dialog 内 Tab。取舍：只补**项目内相对路径**（绝对路径场景少风险高）；与 @ 补全共存（@ 优先） | 2–3 天 |
| N3G-2 | 输入 undo/redo（**已落地**：UndoStack 双栈 100ms 合并 + 边界事件；Ctrl+Z/Y；上限 50 不持久化） | 机制：InputBox 本地双栈；入栈点合并（100ms 窗口或边界事件：提交/粘贴/清空）；Ctrl+Z / Ctrl+Y 与 Ctrl+Shift+Z；IME 组合中不入栈。对标：OC（ctrl+z/super+z）。取舍：历史上限 50，不持久化 | 1 天 |
| N3G-3 | `#` 快捷追加记忆（**已落地**：InputArea 包装层拦截 + tui/memory.ts；不进模型不进历史） | 机制：InputArea 的 onSubmit 包装层拦截首字符 `#` → `tui/memory.ts` 追加 `cwd/AGENTS.md`（空行分隔）+ 📝 通知，不进模型不进历史。对标：CC `#`。取舍：项目级 AGENTS.md（与记忆加载同源）；不经 App（行数红线），模块自治 | 0.5 天 |
| N3G-4 | 空态建议提示词（**数字快捷填入**——复审补强；**已落地**：①②③ 建议空态渲染 + 数字键填入 + ghost 一行） | 机制：转写仅横幅时渲染 3 条建议，前缀 ①②③——**输入为空时按数字键直接填入输入框**（终端原生替代 CC 的可点击建议，成本不变价值翻倍；InputBox 空值分支加三键判定）；输入框空时 ghost 提示 1 条（dim 前缀，输入即让位）。对标：CC 欢迎页可点建议 / OC ghost text。取舍：ghost 只展示不预填 | 1 天 |

**N3H 深度交互批（N3-4 Desktop 之后）**

| ID | 项 | 设计要点 | 量级 |
|---|---|---|---|
| N3H-1 | rewind 粒度三分 | 机制：rewind picker 选中点后弹三选（仅恢复文件快照 / 仅截断对话 / 两者——现行为）；`rewindTo` 增 `options:{files,events}`；仅代码时事件流保留，模型后续被告知文件已回退。对标：CC Esc Esc 三选菜单。**复审注**：真正成本在"仅代码"后的**后续回退点一致性**——之后各点的 fileChanges 计数引用已再次变化的文件，须作废或重算（CC 有独立 checkpoint 体系兜底，kcode 没有）；量级修正为 2–3 天，一致性列为验收项 | 2–3 天 |
| N3H-2 | statusline 脚本注入 | 机制：`/statusline <cmd>` 存 `~/.kcode/statusline.json`；StatusBar 以状态哈希（mode/model/ctx%/branch/busy）为键缓存子进程输出，spawn 传 JSON stdin、500ms 超时、失败回落内置三段。对标：CC /statusline 生态 | 2 天 |
| N3H-3 | 命令面板（Ctrl+K） | 机制：覆盖层第 4 分支（InputArea）；`tui/palette.ts` 动作注册表（**全部内置 + `.kcode/commands` 自定义命令**——复审补：自定义命令必须入面板，本就是斜杠命令一行注册的事—— + 键动作如浏览器/面板/模式切换），模糊过滤 + ↑↓/Enter。对标：OC leader+ctrl+p（其面板可被插件扩展，kcode 先静态注册）。取舍：**自定义键位不做**；面板成熟后**吸收合并 OptionsMenu**（职责重叠双入口冗余——复审补） | 3–4 天 |
| N3H-4 | 计划编辑器（$EDITOR 修订） | 机制：plan approval 面板增"在编辑器中修订"项 → 计划写临时 .md → 复用 `openInExternalEditor` → 返回文本以 revise 语义回 plan_submit（修订稿作新输入注入）。对标：CC Ctrl+G | 1 天 |

**维持不做**：原地编辑历史消息（Static 约束）、会话分享（N4-2）、终端内图片显示、自定义键位（见 N3H-3 取舍）。

**复审结论（2026-09-29，对本节设计的二次审查）**：① 修订七处——N3F-1 改结构化链接先行+截断链接感知+支持面诚实化（VS Code 终端为主战场）、N3G-4 数字快捷填入、N3H-1 量级修正+一致性验收、N3H-3 自定义命令入面板+OptionsMenu 合并注、N3F-6 项目级 MCP 缺口与安全前提、新增 N3F-8 搜索后端可配、N3H-4 语义取舍（修订稿经 $EDITOR 多一跳模型往返，换 plan_submit 机制复用）；② 覆盖度判断：F+G 落地后 CLI 交互面达"无明显高频摩擦"——与 CC 剩余差距集中在 **IDE 集成**（VS Code 扩展：选中上下文/IDE diff/状态显示，最大单项差距，随 N3-4/N4 排期）与生态（N4 范畴），不再是 CLI 本身；③ 已知未排期小项：hooks 拒绝原因内联渲染打磨（现 notice 够用，观察后再说）。

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
| 子代理 | ✅ | ✅（双模：sync 阻塞 / background 异步 + 通知注入 + 子会话落盘 + fan-out 并行） | steer 三态投递与复活（N3D-2，前置 TurnPhase 显式化） |
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
| 可定制 statusline（脚本注入） | ✅（/statusline） | ⚠️ | ✅ tokens | ❌ | N3H-2（§8.4e） |
| 外部编辑器（$EDITOR 长输入/计划） | ✅（Ctrl+G 计划） | ✅（leader+e） | ✅ | ✅（N3C-4④：Ctrl+E，空闲态编辑当前输入并回填） | 计划编辑后批 |
| 剪贴板图片粘贴 | ✅ | ✅ | ✅ | ✅（N3C-4⑤：Ctrl+V 贴图为附件随消息发送；v1 仅 Windows） | 已达标（平台覆盖后续） |
| Tab 路径/斜杠参数补全 | ✅ | ✅ | ✅ | ⚠️ @ 补全有；Tab 路径与命令参数提示无 | N3G-1（§8.4e） |
| 跨会话历史搜索 | ✅（Ctrl+R） | ⚠️ | ✅ | ✅（N3C-4⑥：Ctrl+R 覆盖层，子串过滤 + Enter 回填） | 已达标 |
| Esc Esc 回退（代码/对话/两者分粒度） | ✅ | ✅（revert/fork 消息级） | ✅ | ⚠️ rewind picker 有；粒度未分 | 小项 |
| 后台任务浏览面板 | ✅ | ⚠️ | ✅ | ✅（N3C-4③：Ctrl+T 面板，1s 轮询 + 日志尾部） | 已达标 |
| 子代理进度卡（代理名/活动态/层级导航） | ✅ | ✅（parent/child 导航） | ✅ | ⚠️ 仅工具状态行 | N3D-1（spawned/stopped 事件 + task_output 查活动） |
| 会话侧栏/timeline/分享链接 | ⚠️（/resume picker） | ✅（sidebar+timeline+share） | ✅ | ⚠️ resume picker；share 无 | share 属 N4-2 |
| 消息/输入级 undo-redo | ⚠️ | ✅（leader+u/r + 输入 undo） | ✅ | ❌ | N3G-2（输入级；消息级受 Static 约束不做） |
| leader/命令面板（动作可发现性） | ⚠️（IDE 侧） | ✅（leader+ctrl+p） | ✅ | ⚠️ OptionsMenu 有；无统一面板 | N3H-3（Ctrl+K 面板） |
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

### v6（2026-10-08）

- **菜单视觉打磨批（三截图对比 CC 反馈驱动）**：CC 菜单"舒服"的实质不是行距（同为单倍行距），而是描述弱化+空行分组+层级梯度；kcode 三个对症修复——① 斜杠命令菜单**描述列对齐**（命令名 visualWidth pad 到本批最长+2、封顶 20 列，滚动列不跳动：原先名称长短差被中文全角描述放大成参差错落）；② 可见窗口 8→6（CC 同屏约 7 项，行数少一档扫视更稳；滚动窗算法不变仍可达全部候选）；③ 两处菜单提示行 marginTop=1 留白（InputBox 命令菜单 footer 与 OptionsMenu footer 原先贴着列表零呼吸）；④ banner 键位教学两行砍为一行指路 `输入 / 命令菜单 · /help 全部键位与命令`（Ctrl 系键位三处重复教学——banner/ghost/菜单 footer，收敛到 /help 单一权威源；横幅 4 行→3 行）；⑤ **菜单下移为 CC 下拉形态**（反馈续：CC 菜单在输入框下方展开——输入区固定、菜单往下弹；kcode/zcode 原为上方面板。输入行重排为 分隔线→输入行→分隔线→菜单（slash/@ 文件/路径补全/参数提示四块同步下移，各留一行呼吸）；空态 ①②③ 起步建议同步移到输入区下方（CC suggestions 同位）；附带消除菜单过滤时长短变化导致的输入行上下跳动；IME 安全性论证：可见光标是自绘 █、硬件光标本就停在帧末尾，菜单仅 ASCII 输入时出现）。；⑥ **CC 四截图再对标**（菜单仍觉挤的剩余根因）——斜杠菜单描述列改**固定 19 列定宽**（原按当前过滤集最长名计算，列随过滤移动；CC 定宽沟才有表格稳定感），选中行改 **CC 双层配色**（命令名白粗 + 描述选中 accent/未选中 dim——原整行染品牌色视觉重一档），脚注砍计数与 Tab（`↑↓ 选择 · 回车 执行 · Esc 关闭`，CC 菜单无脚注；@ 文件/路径脚注同步精简），OptionsMenu 计数保留（/model 数十项长清单是唯一位置信号）；向导输入改 **CC 对话框形态**（/add-dir 同款：label 独立行 + 圆角边框输入盒 + 盒内 dim placeholder（ink-text-input 原生支持）+ 提示行斜体 + marginTop 段落留白，HiddenInput 同盒）。全套 159 CLI/511 总用例通过。
- **上下文与状态栏对齐批（zcode 源码 + CC 公开行为对标后实施）**：① 状态栏极简（`mode model — ctx N% — ⎇ branch`：砍累计 I/O ⇅——每轮重发历史数字虚高且 /cost 覆盖；砍空闲快捷键尾巴——横幅+ghost 已教两遍；busy 场景提示保留；ctx 分母=压缩预算与 CC "context left until auto-compact" 同口径；85% 警示色保留）；② provider usage 校准（对标 zcode tokenSource="provider_usage" 优先：consume-stream 回传 lastInputTokens——provider 算的请求输入总量即上下文真值，loop 最近值校准压缩判据与 /context、其后增量估算叠加、无回报退估算；planCompaction 增 measuredTokens 实测优先；压缩成功后校准重置）；③ **预算公式 ADR 修订：早压→晚压**（原 history=窗口×60% 的"早压"取舍撤销——预留物（输出侧/摘要生成/响应缓冲）都是绝对 token 量不随窗口缩放，比例式在大窗压太早小窗余量失真，CC 1M 用户手动调 950k 即实证；改 history=窗口−输出预留 21k−缓冲 13k（zcode 同款）：128k→73%、200k→83%、1M→97%）；④ 压缩失败隔离+熔断（对标 zcode circuit_breaker：自动压缩抛错原先会打断整轮——修 bug 性质；连续 3 次失败停手防风暴，手动 /compact 不受限且错误上抛）；⑤ 窗口表未命中透明化（contextStats 增 windowKnown，/context 注记按默认估算——原先静默回退 128k）。对标依据：zcode compact/policy.ts（窗口−min(32k,21k)−13k、tokenOverride provider_usage、MAX_CONSECUTIVE 3）、app-input-status.tsx（运行行 spinner+右对齐徽章 `73k (12%)`、空闲行仅模型+思考档）；CC 公开文档（statusline 可脚本化、context left until auto-compact 百分比、~83-92% 触发、CLAUDE_AUTOCOMPACT_PCT_OVERRIDE）。全套 498 用例通过（+3）。
- **Esc 可发现性与模型菜单批（A/B 两批，截图反馈 + 命令面审计驱动）**：A 批（Esc 三件套+向导回退）——空闲单击 Esc 出 transient 提示"再按一次 Esc 回退到之前某轮"（2.5s 自清，双击开 rewind 即时清；600ms 双击窗口机制此前不可见是"Esc 无效"感知最大来源，zcode 每次按键消费都有 status 反馈同思路）；login 向导 2-5 段标题统一（Esc 取消）+ 底部统一提示行；OptionsMenu 增 cancelLabel（AskPanel 传"Esc = 拒绝"——取消对象是工具执行）；PromptInput/HiddenInput 增 onBack（**空输入退格 = 上一步**：轻回退用退格、重取消用 Esc 分层，避开 Ctrl+B 浏览器占用与字母键撞输入；向导四段全接线；顺带修复真实退格 DEL() 在无 stdin 补丁组件里归 key.delete 的 Ink 归一差异）。B 批（模型菜单）——provider 层 `listModels()`（GET {baseURL}/models，OpenAI 兼容标准接口，10s 超时失败回空）；contracts LLMProvider 增可选 listModels；session.availableModels() 会话级缓存 5 分钟；/model 无参改全量菜单（当前会话置顶高亮/配置默认/端点清单去重合并，Enter 会话级切换语义不变，拉取失败回退两项形态）；OptionsMenu 滚动窗（10 行+i/N 计数，长清单不再整屏铺开，全面板受益）；MenuOption 增 value（取值不再解析 label）；login 保存前探测验证 key+地址连通并校准默认模型（预填不在清单取第一个；端点不支持 /models warn 不阻断）。参照：opencode /connect 两步向导+models.dev（取验证思路不引外部目录），CC 自定义模型也进 /model 菜单。全套 511 用例（+13）。
- **斜杠命令菜单对齐批（截图反馈驱动，zcode 源码 + CC 行为对标）**：修复可达性 bug——候选渲染曾 `slice(0,8)` 截断而高亮索引在全量 matches 上循环，输入 / 时第 9 项起（内置 19 命令）看不见也选不中；改 zcode visibleSlashCommandWindow 同款滚动窗（选中项滚入视野）。匹配两级（前缀优先、子串次之，/onte 可达 /context；zcode 同 includes）。Enter=执行高亮命令（zcode resolveComposerSubmittedText/CC 同语义，消除'补全后再回车'一跳），Tab 保持补全。Esc 关菜单保留输入（原整段清空丢草稿；dismissed needle 标记，输入变化重开）。计数指示（i/N）+ needle 变化高亮复位。测试 +5（cmd-menu）。
- **N3G 输入补全批落地（4/4，§8.4e 表已标注）**：① N3G-3 `#` 快捷记忆（InputArea onSubmit 包装层拦截首字符 # → `tui/memory.ts` 追加 cwd/AGENTS.md 空行分隔——与 loadAgentsMd 同源即下次会话装载；📝 通知；不进模型不进历史；busy 中可用；裸 # 提示无内容；模块自治不经 App）；② N3G-2 undo/redo（`tui/input/undo.ts` UndoStack 快照双栈：100ms 窗口合并连续编辑、窗口锚定入栈点长连打按块分段、上限 50 不持久化；边界事件=粘贴/IME 上屏（多字符一次插入——终端不上报组合过程即天然不入栈）/提交清空（误触回车 Ctrl+Z 找回草稿）/菜单 Esc/历史回填；InputBox 全值变化经 effect 记录含外部清空，undo/redo 自身改值置 skip；Ctrl+Z/Ctrl+Y（Ctrl+Shift+Z 尽力区分）在通用 ctrl 早退前处理）；③ N3G-4 空态建议（转写仅横幅且输入为空渲染 ①②③ 三条起步建议，数字键 1..n 直接填入不提交——终端原生替代 CC 可点击建议；ghost 一行 dim 提示只展示不预填输入即让位；转写出内容块后建议消失）；④ N3G-1 Tab 三态补全（无菜单 Tab 判定：路径形态 token 含 /或\或 ./ → pathMenu——file-complete 泛化 completePath 前缀匹配/反斜杠归一/./剥离/大小写不敏感、只 startsWith（子串是噪声）、复用 listProjectFiles 缓存、菜单 ↑↓/Tab 插入+尾空格/实时重过滤（同结果返回原引用防 effect↔state 循环）、只补项目内相对路径；命令参数位 `/cmd ` 定格即 argsHint 提示展示不插入——CommandInfo 增 argsHint 字段内置逐个补文案、自定义命令说明 $ARGUMENTS 模板；@ 优先既有 fileMenu 先判；菜单插入标 undo 边界；顺带清掉 builtin-commands 的 CommandInfo 重复声明）。全套 27 文件 495 用例通过（+19）。
- **N3F 终端打磨批落地（8/8，§8.4e 表已标注）**：① N3F-4 respond 载荷统一 `SUBAGENT_NOTIFICATION_HEADER` 防伪头（TUI 📩 分支同源命中；常量移 agent-messaging.ts 防 subagent↔agent-messaging 循环引用，subagent.ts 转出口保持导入路径）；② N3F-5 `--model <provider/model>` 第四层覆盖（N3E-3 三层之上优先级最高，给了即不需 default；contracts 导出 `isModelRef` 同源校验 + 未知 provider fail-fast 列可用清单，裸模型名沿 default 的 provider 与路由同规则；TUI/headless 单一生效点）；③ N3F-2/3 标题栏+完成铃（`tui/terminal/title.ts` OSC 0 busy/活动变化写、空闲/卸载复位；`notify.ts` busy 下降沿 ≥10s 响 BEL，`bellOnEdge` 纯函数；session 导出 `isBackgroundCompletionNotice`——后台完成（含中断/失败）同触发、respond 中间消息同头不响；KCODE_TITLE/KCODE_BELL=0 门；App 各一行 effect，activityLabel 上移保 hook 规则）；④ N3F-8 搜索后端可配（`KCODE_SEARCH=duckduckgo|searxng|none` + `KCODE_SEARXNG_URL`；none 时工具组不注册 web_search——模型不可见即不可误用；非法值/缺 URL fail-fast；SearXNG 走实例 JSON API，实例地址来自 env 不经模型输入无 SSRF 面扩大）；⑤ N3F-1 OSC8 结构化链接一期（**POC 提前探路**：string-width 5.1.2 对 ST/BEL 终止的 OSC8 均计 0 宽（Ink 布局安全），但 slice-ansi 截断丢闭合序列、grapheme 逐簇拆碎序列——结论固化进宽度回归测试；`truncateVisual` 改链接感知：序列零宽直通、预算只耗 label、截中补闭合；`links.ts` hyperlinksEnabled 默认仅 `TERM_PROGRAM=vscode`+TTY（file:// 点击直达编辑器仅 VS Code 成立），KCODE_LINKS=1 手动开/0 强制关；结构位=工具 argsPreview 路径（read 带 #L 行锚）+三段落盘注记+后台任务日志行（自家常量格式零误报，非文本扫描）；检查点/子代理会话路径 TUI 不显示原始路径，如实未接；二期可选才扩 assistant 正文 code span）；⑥ N3F-6 `kcode mcp` 子命令（`mcp-cmd.ts` 镜像 doctor 的 print/exit 约定；add 双形态 stdio `--` 后命令/远程 url+--transport http|sse；写 mcp.json 前 zod 校验 + tmp/rename 原子写，损坏文件拒覆盖提示手动修复；test 复用 connectMcpServers+10s 超时（定时器 unref+clear 不拖进程退出）；同名拒加/未知名列清单；项目级 MCP 缺口维持复审结论——/trust 门控前不实作）；⑦ N3F-7 headless 流式文本（`-p` 非 --json onDelta 直写 stdout：DeltaWriter 64 字节/50ms 先到即冲刷防逐 token 系统调用抖动；**先冲刷再分支**——流式末尾换行收尾（已有换行不补）不重复摘要行，无正文回退一行摘要；main 传独立原始写通道（print 逐次补 \n 会碎正文）；--json 纯 NDJSON 不变）。全套 22 文件 476 用例通过（+52）。

### v5（2026-09-29）

- **§8.4e 二次复审修订（7 处）**：N3F-1 改结构化链接先行（CC/OC 链接来自结构位非文本扫描）+截断链接感知+支持面诚实化（VS Code 终端为主战场）；N3G-4 数字快捷填入（终端原生替代可点击建议）；N3H-1 量级修正 2-3 天+后续回退点一致性验收；N3H-3 自定义命令入面板+OptionsMenu 合并注；N3F-6 记项目级 MCP 缺口（安全前提 /trust 门控，排 N3H 后）；新增 N3F-8 搜索后端可配；N3H-4 语义取舍声明。复审结论：F+G 落地后 CLI 交互面达"无明显高频摩擦"，与 CC 剩余差距=IDE 集成（N4）+生态（N4），不再是 CLI 本身。
- **CLI 体验审计与三期设计定稿（§8.4e 新增）**：对标 CC/OC/zcode 盘点未落地项，按价值密度分三批——N3F 终端打磨（OSC 8 可点击链接[POC 先行防 Ink 宽度风险]/标题栏进度/完成 bell/respond 显示瑕疵修复[载荷统一防伪头]/--model 旗标/kcode mcp 子命令/headless 流式文本，≈1 周）；N3G 输入补全（Tab 路径+命令参数补全[InputBox 状态机专批]/输入 undo-redo/# 追加 AGENTS.md[InputArea 拦截不经 App]/空态建议+ghost，≈1 周）；N3H 深度交互（rewind 三分粒度/statusline 脚本/Ctrl+K 命令面板/$EDITOR 计划修订，N3-4 之后）。§0 路线图与 §9.2 四行同步；明确不做：原地编辑消息（Static）、会话分享（N4-2）、终端图片、自定义键位。
- **N3D-2 主体落地（子代理消息互通，设计修订后实施）**：开工前设计审查发现三处不合理并调整——① zcode 三态投递的"空闲排队"在 kcode 不存在（子代理一次 run 即终态）→ 简化为两态回执（steered/resumed），终态同 loop 开新 run 即"复活"（单进程内存历史无损，优于 zcode resumeFromStore——其需要它因 runtime 不留内存）；② 寻址缺基础设施 → 新增 `session/subagent-registry.ts` 句柄注册表（持 AgentLoop 引用；终态 LRU 上限 8——单进程内存自管，zcode 由 runtime 生命周期托管无此问题）；③ respond 不另建命令类型 → 复用 N3D-1 notify 通道（`<subagent-message>` XML 载荷）。实现：`core/loop.ts` 增 `pendingInputs`+`steer()`（以 TurnMachine.phase 判运行中——前置任务价值兑现）+ while 顶模型步边界 drain（注入走既有 user_message 事件，回放/resume 自动一致，契约零新增）；`session/agent-messaging.ts` 两工具（send_message 父专属不进 baseTools——子代理不可互发，对齐 zcode 门控；respond_to_coordinator 无条件注入子代理工具面）；subagent 双注册（元数据进 BackgroundTaskRegistry/句柄进 SubagentRegistry）；行数治理：settle-results.ts 外迁（loop 486 行）。修复：早前补丁引入的 `join("\n")` 双反斜杠源码缺陷（会产出字面 
 文本）。测试 +7（steer 确定性注入——工具 execute 期同线程触发；两态投递；LRU；respond 载荷；组合级全链路：后台子代理中途 respond → 父收通知开新 turn 应答）。教训：bash heredoc 对含反斜义内容不可靠，改用 Edit/Write 工具直写。
- **TurnPhase 显式化落地（N3D-2 前置）**：`packages/core/src/core/turn-state.ts`——八态（Idle/ProcessingInput/Streaming/SchedulingTools/ExecutingTools/AggregatingResults/Completing/Error；zcode 十态裁剪：kcode 流式即刻开始无独立 AwaitingModelResponse、权限等待在执行内）+ `TURN_TRANSITIONS` 迁移表（Completing/Error 终态只回 Idle；AggregatingResults 保留回 SchedulingTools 为重调度预留）+ `transition()` 唯一强制点（非法迁移抛错 fail-fast）+ `finish()` 幂等归位（Error/Completing 直回 Idle）。loop.ts 十处位点推进，`AgentLoopPorts.onPhase` 观察缝；流式消费抽为 `consume-stream.ts` 独立模块（循环依赖以结构化内联类型解开；loop.ts 477 行达标）。测试 +8（迁移表单测 5 + 真实 loop 三路径序列断言：多轮工具/纯文本/流式错误归位与连续 run 干净起步）。**既有 424 用例零改动全过——所有现存路径天然只走合法迁移，这是对状态机设计正确性的最强验证。**
- **N3E 子批三落地（6/6 收尾）**：⑤ 配置三层覆盖（loadUserConfig 增 cwd/env 参数：Project `.kcode/config.json` 仅接受 default——项目级 providers 一律忽略防投毒；Env 白名单 KCODE_DEFAULT_MODEL 最高优先）；⑥ 空闲压缩（sink 事件刷新 idle 锚点，超阈值（默认 60min，idleCompactMs 可注入）下一次输入先 persistedCompact——与手动 /compact 同一落盘路径）。测试 +4。
- **N3E 子批一+二落地（执行层体验批 4/6）**：① bash 前台输出三段预算（`output-collector.ts`：内联 30k / 超限全文落盘 `artifacts/<callId>.log` / 尾部 2k 保留——构建类输出"结尾才是结论"；内存硬顶 1M 超限保头尾+诚实注记；落盘失败降级建议重定向；shell 探测函数外迁 `shell-detect.ts` 行数治理）；② cd 持久项目边界（越界重置回会话目录并输出告知，对标 decideBashCwdPolicy）；③ `kcode update`（latest.json URL/本地双通道 → 平台/版本守卫 → size+sha256 校验 → staging 原子换名 releases/<ver> → 翻 current Junction；**教训：Node spawnSync("tar") 在 Windows 命中 Git 的 GNU tar 会把 "C:" 当远程主机——显式用 System32 bsdtar**）；④ 凭证机器指纹回退（口令 > DPAPI > 指纹三级降级；原代码"禁止机器 ID 派生密钥"原则修正为显式降级层，弱点已在 §7 声明）。N3E-3 配置覆盖层与 N3E-6 idle 微压缩留下一批。测试 +11（bash-output 6 / update 5 含真实 tar 打包通道与指纹稳定性）。
- **N3D-1 落地（子代理异步化一期，含审计增补三项）**：① `task` 增 `wait:"sync"|"background"`——background 立即回执（agentId + childSessionId），子代理注册进 `BackgroundTaskRegistry`（task_output/task_stop/任务面板直接复用；task_output 对 `sub_` 任务把子会话 JSONL 逐行解析成活动摘要）；② 完成通知经 `notify` 注入（父忙=入队 next 命令走既有 drain，父空闲=直接开新 turn），通知文本带 `[SYSTEM NOTIFICATION - NOT USER INPUT]` 防伪头（TUI 渲染为 📩 系统通知而非用户消息）；③ 幂等 `notified`：sync 的 tool_result 送达即认领、task_output 终态读取即认领，防双送达；④ 子会话双写落盘 `sessions/subagents/sub_<id>.jsonl`（独立子目录不污染 /sessions 清单；回放/审计/二期复活基础）；⑤ `ask_user` 经父端口透传（子代理 base prompt 同步改写）；⑥ contracts 增 `subagent_spawned`/`subagent_stopped` 事件（TUI 🤖 进度行）；⑦ Esc 连杀：composition `abort()` 先杀后台子代理再中断父（挂起工具经 ctx.signal 确定性收敛，中断归一 stopped 态——工具 abort 走抛错路径的也归一）；⑧ **执行器并行组**：`ToolDefinition.concurrentSafe` 声明 + 连续并行工具成组（组内 ≤10 并发）、写类单例组、组间顺序、失败不截断后续组、结果保持原序——修复"混入一个写调用全批串行"，task 声明 concurrentSafe 支撑多子代理 fan-out；⑨ **不活动看门狗（120s）替换 600s 墙钟**（task 移除 timeoutMs，子事件流活动即重置）。测试 +8（executor-groups 5：分组重叠时序/fan-out/串行/失败不截断/预中断；subagent-background 3：组合级全链路含通知注入与子会话落盘/sync 行为不变/连杀归一）。调试教训记录：ScriptedLLM 脚本是扁平 ScriptedTurn[]（嵌套数组会静默空转）；测试桩 hooks 必须返回 `{veto:false}` 形状（pipeline 直读 verdict.veto）。
- **全量对标审计落地（差异×问题×优化设计）**：① N3D-1 增补两项（执行器并行组 fan-out——`concurrentSafe` 声明+分组执行，修复"混入一个写调用全批串行"；task 不活动看门狗替换 600s 墙钟）；N3D-2 增前置任务（TurnPhase 显式化——原 benchmark §3"微调"定级升格；steer 状态独立成层的 zcode 教训）；② 新增 §8.4d N3E 执行层体验批六项（bash 三段预算/cd 项目边界/配置 Env+Project 覆盖层/kcode update 自更新/凭证机器指纹回退/idle 微压缩）；③ **ADR-11 修正**：zcode 实测**无 TUF**（仅 SHA-256+尺寸校验，`releaseDownload.ts:137`），kcode 基线改为 sha256+https 同级、TUF 降为可选增强；④ §7 诚实边界增两条（Static 转写不可逆约束；子代理结论信任链）。依据：zcode 六子系统源码解剖（OutputCollector/五级合并/TurnPhase/更新链/凭证指纹/调度器）。
- **N3D 设计定稿（子代理异步化与消息互通，采纳 zcode 模式）**：新增 §8.4c 两期设计——一期 N3D-1（后台子代理 + 完成通知经 RuntimeCommandQueue 注入 + 子会话 JsonlSessionSink 落盘 + ask_user 透传 + spawned/stopped 事件 + notified 幂等 + 防伪头，~1 周，全部复用既有积木）；二期 N3D-2（AgentLoop 步边界 drain 钩子 + SendMessage 三态投递 steer/排队/复活 + RespondToCoordinator 异步单向，1-2 周）。依据：对 zcode 本地克隆（`29628c9`）的源码解剖（SendMessage 三态投递 `runner.ts:900-1062`、通知=命令队列 `runtime-command-queue.ts:317`、detach/幂等/账本等机制，详见 benchmark §1.5 修订）。明确不抄：profile 系统、持久通知账本、branchGeneration、闲时轮拒发、toolCallId 镜像重写。§0 路线图、§9.1 子代理行、§9.2 进度卡行同步。
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

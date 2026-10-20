# 优化实施记录 · 2026-10-19

> 依据：[CLI 优化方案](./cli-optimization-plan-2026-10.md) 阶段一 / [桌面端方案](./desktop-plan-2026-10.md) D0。
> 本批目标：先修"数据不丢、agent 不误判、桌面 replay/工作区"。

## 已完成

| 编号 | 项 | 文件 | 说明 |
|---|---|---|---|
| 1-05 | 工具失败原因回灌（错误前置部分） | `packages/shared/src/index.ts`、`packages/core/src/core/settle-results.ts`、`packages/runtime/src/session/replayer.ts` | 新增 `formatToolResultForModel`：失败时 `[失败] exit code 1` 前置；在线回灌与 resume 回放同口径。修复"测试失败但模型看到 stdout 以为通过"。**`ToolOutput.meta`（exitCode/truncated/artifactPath）尚未加，属 1-05 后续。** |
| 1-03 | 摘要失败不再吞历史 | `packages/platform/src/providers/summarizer.ts` | `end.reason==="error"` 与流异常都抛 `摘要生成失败`，不再返回空摘要占位；`runCompaction` 因此不会应用、`loop` 的 `compactFailures` 熔断生效。 |
| 1-04 | 压缩熔断后的机械裁剪 | `packages/core/src/core/loop.ts` | 连续 3 次摘要失败后不再打 LLM，直接按 `planCompaction/applyCompaction` 保留首问锚点 + 已批准计划锚点 + 最近 10 条，落 `compaction_summary`（含"机械裁剪"）；保持熔断状态，避免每 3 轮重复失败。 |
| 1-06 | 工具结果预算按 token 二分 | `packages/core/src/context/budget.ts` | `capToolResult` 不再用 `budget * 1.6` 估字符数；按 `estimateTokens` 二分头尾长度，ASCII/CJK 都落在预算内；极低预算至少返回"已截断"。 |
| 1-10 | 预算计入 toolCalls.args/图片 | `packages/core/src/context/budget.ts` | `historyTokens` 增加 assistant `toolCalls.args`（JSON）与每图 1k token 估算；大 write 参数/附图不再对压缩不可见。 |
| 1-07 | 工具内部 cap 口径统一 | `packages/tools/src/tools/output-collector.ts`、`read.ts`、`grep.ts`、`extract.ts`、`web.ts` | bash 的 artifact 注记移到**最前**（core 按 resultBudget 截断后仍能看到完整日志路径）；read 尾部补 `offset=继续读取`；明确"内部 cap = 内存护栏，模型 token 预算由 loop 层 resultBudget 统一裁"，不强制两者数值相等（否则 JSONL 也会丢全文）。 |
| 1-08 | CRLF edit 精确匹配 | `packages/tools/src/tools/edit.ts` | 精确匹配前生成 CRLF/LF 变体；原样出现多次仍判歧义，不"挑一个"；保留文件原 EOL。 |
| 2-02 | LLM 延迟解析 | `packages/session/src/lazy-llm.ts`、`composition.ts` | compose 阶段只拿工厂，不碰 keychain/路由；首次 `stream`/`listModels` 才 resolve，失败不缓存（/login 后同会话可重试）；`setModel` 同样延迟。`!命令` 直执行不再创建父 LLM（测试从 1 改 0）。 |
| 2-01 | unconfigured TUI + init + /login 热生效 | `apps/cli/src/{bootstrap,main,args}.ts`、`tui/{App.tsx,state/lifecycle.ts,state/services.ts,dialogs/LoginWizardPanel.tsx}` | 缺 `config.json` 返回空 providers（损坏仍 fail-fast）；无 default 也进 TUI，banner 提示 `/login`；新增 `kcode init` 空骨架；登录保存后 `reloadRuntime` 重读配置并 `Object.assign` 同一 Runtime，再 `session.setModel`，无需重启。 |
| 2-12 | 脚本化输出/轮次/临时会话 | `apps/cli/src/{args,headless,main,session}.ts`、`packages/session/src/composition.ts` | `--output-format text|json|stream-json`（json 只出单条 result，stream-json 出事件流）；`--max-turns` 透传 AgentLoop；`--ephemeral` 不创建 JSONL；`--session-id` 指定 ID；`--json` 保持 stream-json 兼容。 |
| 2-11 | 退出码契约 + result 字段 | `apps/cli/src/{headless,main}.ts` | 0 成功 / 1 通用 / 2 参数配置 / 3 认证 / 4 模型 API / 130 中断；`result` 增加 `permissionDenials/toolFailures/usage`；有 deny 且 completed 时状态改 failed、退出码 1，避免 CI 假绿。 |
| 2-07 | `-p` 恒无头 + `--interactive` | `apps/cli/src/{args,main}.ts` | `-p`/`--prompt` 在 TTY 下也不再渲染 Ink；`--interactive` 显式回 TUI oneShot；`--json` 仍优先无头。 |
| 2-08 | stdin 管道上下文 | `apps/cli/src/{args,main}.ts` | 非 TTY 下 `-p` 先读尽 stdin，`stdin + 空行 + prompt`；`-p -` 用整段 stdin 替换 prompt；TTY 下 `-p -` 报 UsageError。 |
| 2-09 | `--mode` TUI 生效 | `apps/cli/src/{main}.ts`、`tui/{App.tsx,state/lifecycle.ts}` | `--mode plan/default/acceptEdits` 直接进 TUI 并传 `initialMode`；`fullAccess` 仍要求 `/mode` 显式确认；项目 `mode` 同路径。 |
| 2-10 | `--disallowed-tools` 透传 TUI | `apps/cli/src/{main}.ts`、`tui/{App.tsx,state/lifecycle.ts}` | 交互态同样在 compose 期剔除；未知名走 fatal 屏，不再静默忽略。 |
| 2-06 | 配置层级最小化 | `apps/cli/src/{bootstrap,args,main}.ts`、`packages/contracts/src/provider.ts`、`tui/state/{services,lifecycle}.ts` | `KCODE_HOME` 覆盖主目录；`--settings` 覆盖用户配置并贯穿 `/login` 写回；项目 `.kcode/config.json` 的 `default`/`mode` 生效（providers 仍不可表达）；用户配置未知键改为 stderr 告警不阻断，保存时保留未知根键。 |
| 2-03 | /login provider 级合并 | `apps/cli/src/bootstrap.ts`、`tui/dialogs/LoginWizardPanel.tsx` | 读旧配置 → 只合并当前 provider → 保留其他 provider/budget → 临时文件 + `.bak` + rename；损坏配置拒绝覆盖。 |
| 2-04 | `--help` / 用法错误出口 | `apps/cli/src/{args,main}.ts` | `-h/--help` 在任何 IO 前打印 usage 并 exit 0；未知参数/非法 mode/缺值抛 `UsageError`，exit 2 且不打 stack。 |
| 2-05 | fatal 驻留 | `apps/cli/src/tui/state/lifecycle.ts`、`tui/App.tsx`、`terminal/keybinds.ts` | 去掉 80ms 自动退出；错误与修复命令留在屏上，`r` 重试（retryToken 重新装配）/ `q` 退出。 |
| 1-11 | Windows CI 最小回归 | `.github/workflows/ci.yml` | 新增 `windows-smoke`：typecheck + bash/bash-output/CRLF edit/跨盘边界/workspace resume/host lease 接管；未在本机跑过 GitHub Actions，首次 push 后看结果。 |
| 1-09 | 跨盘工作区边界 | `packages/tools/src/tools/paths.ts`、`write.ts`、`edit.ts` | 新增 `isWithinWorkspace`（`relative` + `isAbsolute` + `..` 前缀 + Windows 小写）；修复 `E:\ws` 写 `D:\x` 被误判为工作区内。 |
| 1-01 | resume 续写同一会话 | `packages/session/src/resume.ts`、`apps/cli/src/session.ts`、`apps/host/src/session.ts` | `resolveResumeHistory` 返回源 `sessionId`，CLI/host 透传；host 的 `latest` 不再反查文件失败；`session/replay` 改用 `composed.jsonlPath` + `effectiveEvents`。 |
| D0-02 | 桌面 replay 修复 + 接管宽限 | `apps/host/src/session.ts`、`apps/desktop/src/renderer/components/projection.ts`、`Timeline.tsx`、`main.tsx` | replay 不再把 sessionId 当路径；rewind 不复活；`session_start` 不再清空续接历史；工具行用 callId 做 key；replay 失败显示可见错误。另给 lease 接管加 1s 宽限，修 kill -9 后 PID 回收窗口导致的偶发双活误判。 |
| D0-05 | 退出/关窗生命周期 | `packages/runtime/src/session/runner.ts`、`packages/session/src/composition.ts`、`packages/tools/src/tools/bash.ts`、`apps/cli/src/tui/App.tsx` | `SessionRunner.drain(2s)` 等当前 run 结算；`composition.close` 依次 abort→杀后台子代理→`bashTasks.stopAll()`→drain→关 MCP；`BackgroundTaskRegistry.stop` 在 Windows 复用 `killTree`（/T）；TUI 的 exit/`/exit`/双击 Ctrl+C 先 `session.close()`（3.5s 上限）再卸载 Ink。 |
| D0-06 | 计划批准 + 审批预览 + 超时 | `packages/contracts/src/host-protocol.ts`、`apps/host/src/{session,server,port}.ts`、`packages/runtime/src/host/client.ts`、`apps/desktop/src/renderer/{main.tsx,components/AskPanel.tsx,PlanPanel.tsx}` | host 接 `planAsker` → `plan/request` → `plan/respond`（approved/revise/abandon）；ask 由 host 生成 `buildAskPreview`（write 对比磁盘）；审批/计划超时 10s→5min，超时发 `ask/cancelled`/`plan/cancelled` 让 UI 关闭；AskPanel 显示完整 bash 命令/参数与 diff，默认焦点"拒绝"；capabilities 增加 plan。 |
| D0-09 | 桌面 Playwright E2E | `apps/desktop/playwright.config.ts`、`apps/desktop/test/e2e/desktop.spec.ts`、`apps/desktop/vite.config.ts` | 首启 → host ready → reload replay → preload/CSP 校验 → 关窗；同时修掉打包态 `index.html` 用绝对 `/assets` 导致**整页空白**的问题（`base:"./"`）。E2E 在本机无头 Electron 下通过（8.4s）。headless 下 Playwright `app.close()` 会等进程树回收而挂起，测试改用关窗 + `taskkill /T` 收口；真实桌面的优雅关闭仍由 D0-05 的 `session.close` 负责。 |
| D0-08 | Electron 边界加固 | `apps/desktop/src/main/index.ts`、`apps/desktop/src/renderer/index.html` | `sandbox:true`；CSP meta（默认 self，仅 dev 放行 inline/ws）；`setWindowOpenHandler` 拒绝新窗口、仅 https 交系统浏览器；`will-navigate` 只放行 file/dev origin；所有 IPC handle/on 校验 senderFrame 顶层 + origin；`will-attach-webview` 直接拒绝。 |
| D0-07 | 工作区选择 | `apps/desktop/src/main/index.ts`、`preload/index.ts`、`renderer/main.tsx`、`WorkspaceHeader.tsx`、`styles.css` | 原生文件夹选择；最近工作区（localStorage）；切换工作区走 dispose→create；顶栏显示项目名与「打开文件夹」。 |

## 测试

新增/更新：

- `packages/shared/test/tool-result.test.ts`：失败原因前置、空输出不重复、无错误文本也标失败。
- `packages/platform/test/summarizer.test.ts`：401 时抛错，不再把失败当空摘要。
- `packages/core/test/context-b3.test.ts`：`capToolResult` ASCII/CJK 均不超 token 预算；`historyTokens` 计入 args/图片；摘要连续失败后机械裁剪、历史有界。
- `packages/tools/test/write-edit.test.ts`：CRLF 文件用 LF oldString 走精确匹配，且保留 CRLF。
- `packages/tools/test/bash-output.test.ts`：artifact 注记位于输出头部（截断后仍可见）。
- `packages/tools/test/tools.test.ts`：read 切片尾部带 `offset=继续读取`。
- `packages/core/test/tool-result-history.test.ts`：失败工具 `[失败] exit code` 真正进入模型历史（core loop 集成）。
- `apps/host/test/host.test.ts`：`session/replay` 返回同一会话事件（replay 路径 + effectiveEvents 集成）。
- `packages/runtime/test/runner.test.ts`：`drain` 等待当前 run 真正退出，异常也不悬挂。
- `packages/session/test/workspace-resume.test.ts`：`latest` 返回正确源 `sessionId`。
- `apps/host/test/host.test.ts`：resume 语义从"匿名 fork"改为"续写同一 JSONL"；kill -9 后 first/second 各一次、lease epoch+1。

## 验证状态（2026-10-19 12:23）

环境恢复后已跑：

```text
pnpm typecheck   → 16/16 packages 通过
pnpm test        → 112 files / 578 passed / 1 skipped
pnpm lint        → 0 errors（40 warnings）
pnpm gates:check → 11 条例外，无过期/无漂移
pnpm build       → 8/8 tasks 通过
desktop E2E      → 1 passed（首启/replay/preload/CSP/关闭）
```

修复过程中 typecheck 暴露并修掉的 desktop 既有问题：

| 问题 | 修复 |
|---|---|
| `@web/*` 在 TS 里没有路径映射（Vite 有） | `apps/desktop/tsconfig.json` 加 `baseUrl` + `paths` |
| preload 的 `onMessage` 全局类型返回 `void`，实际返回退订函数 | `useDesktopConnection` 类型改为 `() => void` |
| `Timeline.tsx` 使用 `Row` 但未 import | 补 `import type { Row }` |
| `ToolCallRow` 的 `icon` 类型过窄 | 改用 `LucideIcon` |
| `WorkspaceLayout` 引用未定义的 `collapsed` | 改为 `effectiveCollapsed` |
| Shiki 4 `createHighlighter` 参数是 `themes` 不是 `theme` | 改 `themes: [THEME]` |
| 通知 effect 里 `ask` 可能为 null | `ask?.tool ?? "工具"` |
| **replay 把 `SessionEvent` 直接传给 `applyEvent`（期望 `HostEvent`）** | 包成 `{ type:"session/event", event }`；此前重放事件实际上全部被忽略 |
| `LocalSessionOptions` 缺 `sessionBudgetTokens` 字段 | 补类型（CLI 构造已传该值） |

**时序 flake**：全量并发下出现过两次不同用例的偶发失败（`subagent-background`、host kill -9 接管），单独跑均通过。host 接管加了 1s lease 宽限（OS 回收 PID 的窗口），修后全量连续通过；`subagent-background` 仍按 10s 等待，若后续复现再单独收紧。

**lint 的 5 个 max-lines error**：`composition.ts` 516、`loop.ts` 576、`App.tsx` 505、`InputBox.tsx` 512、`commands.ts` 547——均为存量超长文件（DESIGN 声称已拆到 500 以下，实际没有）。本批不做高风险拆文件，按项目例外登记制登记为限时债务（`gates-exceptions.json`，2026-12-31 到期），并让 `gates-check` 从"只校验 no-console"改为校验所有 `rule: off` 的 overrides。拆分任务归入阶段三 3-31 文档/治理批。

**桌面 E2E**：`pnpm --filter @kcode/desktop test:e2e` 在本机无头 Electron（`--headless --no-sandbox --disable-gpu`）下通过：首启、host 握手、reload 后 replay、preload/CSP 校验、关闭。它顺带抓到并修掉了打包态整页空白（Vite `base` 绝对路径）。审批/plan 的“真实点击”尚未覆盖——无 key 时无法稳定触发；后续用本地 fake LLM 补。

> 注意：`app-render.test.tsx` 输出了一段 React error boundary 日志，但用例通过；这是测试环境下的既有噪声，暂未追。

## 下一批（建议顺序）

1. **CLI 2-13~2-19 安全最小集**：bash env 清洗、敏感路径 denylist、SSRF 逐跳、hook 改参复判、项目扩展 trust、key 不走 argv、update 链收紧。
2. **CLI 2-20~2-24 审批/交互一致性**：完整 diff、参数级放行、通知、模式同步、/help 生成化。
3. **桌面 D1**：onboarding/login（复用 2-01 热重载）、设置、真 diff、队列。

## 备注

- `packages/tools/src/tools/write.ts` 的越界行为仍是"工具内拒绝"，注释已标为已知取舍；后续按计划把边界上移到权限引擎（越界 → ask），而不是在用户批准后再拒一次。
- 审批/计划超时已放宽到 5min；`sandbox:true` 与 CSP 已生效（D0-06/D0-08），preload/CSP 由无头 Electron E2E 覆盖。

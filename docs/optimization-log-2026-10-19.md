# 优化实施记录 · 2026-10-19

> 依据：[CLI 优化方案](./cli-optimization-plan-2026-10.md) 阶段一 / [桌面端方案](./desktop-plan-2026-10.md) D0。
> 本批目标：先修"数据不丢、agent 不误判、桌面 replay/工作区"。

## 已完成

| 编号 | 项 | 文件 | 说明 |
|---|---|---|---|
| 1-05 | 工具失败原因回灌（错误前置部分） | `packages/shared/src/index.ts`、`packages/core/src/core/settle-results.ts`、`packages/runtime/src/session/replayer.ts` | 新增 `formatToolResultForModel`：失败时 `[失败] exit code 1` 前置；在线回灌与 resume 回放同口径。修复"测试失败但模型看到 stdout 以为通过"。**`ToolOutput.meta`（exitCode/truncated/artifactPath）尚未加，属 1-05 后续。** |
| 1-03 | 摘要失败不再吞历史 | `packages/platform/src/providers/summarizer.ts` | `end.reason==="error"` 与流异常都抛 `摘要生成失败`，不再返回空摘要占位；`runCompaction` 因此不会应用、`loop` 的 `compactFailures` 熔断生效。 |
| 1-08 | CRLF edit 精确匹配 | `packages/tools/src/tools/edit.ts` | 精确匹配前生成 CRLF/LF 变体；原样出现多次仍判歧义，不"挑一个"；保留文件原 EOL。 |
| 1-09 | 跨盘工作区边界 | `packages/tools/src/tools/paths.ts`、`write.ts`、`edit.ts` | 新增 `isWithinWorkspace`（`relative` + `isAbsolute` + `..` 前缀 + Windows 小写）；修复 `E:\ws` 写 `D:\x` 被误判为工作区内。 |
| 1-01 | resume 续写同一会话 | `packages/session/src/resume.ts`、`apps/cli/src/session.ts`、`apps/host/src/session.ts` | `resolveResumeHistory` 返回源 `sessionId`，CLI/host 透传；host 的 `latest` 不再反查文件失败；`session/replay` 改用 `composed.jsonlPath` + `effectiveEvents`。 |
| D0-02 | 桌面 replay 修复 | `apps/host/src/session.ts`、`apps/desktop/src/renderer/components/projection.ts`、`Timeline.tsx`、`main.tsx` | replay 不再把 sessionId 当路径；rewind 不复活；`session_start` 不再清空续接历史；工具行用 callId 做 key；replay 失败显示可见错误。 |
| D0-07 | 工作区选择 | `apps/desktop/src/main/index.ts`、`preload/index.ts`、`renderer/main.tsx`、`WorkspaceHeader.tsx`、`styles.css` | 原生文件夹选择；最近工作区（localStorage）；切换工作区走 dispose→create；顶栏显示项目名与「打开文件夹」。 |

## 测试

新增/更新：

- `packages/shared/test/tool-result.test.ts`：失败原因前置、空输出不重复、无错误文本也标失败。
- `packages/platform/test/summarizer.test.ts`：401 时抛错，不再把失败当空摘要。
- `packages/tools/test/write-edit.test.ts`：CRLF 文件用 LF oldString 走精确匹配，且保留 CRLF。
- `packages/session/test/workspace-resume.test.ts`：`latest` 返回正确源 `sessionId`。
- `apps/host/test/host.test.ts`：resume 语义从"匿名 fork"改为"续写同一 JSONL"；kill -9 后 first/second 各一次、lease epoch+1。

## 验证状态（2026-10-19 12:23）

环境恢复后已跑：

```text
pnpm typecheck   → 16/16 packages 通过
pnpm test        → 110 files / 559 passed / 1 skipped
pnpm lint        → 0 errors（40 warnings）
pnpm gates:check → 11 条例外，无过期/无漂移
pnpm build       → 8/8 tasks 通过
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

**lint 的 5 个 max-lines error**：`composition.ts` 516、`loop.ts` 576、`App.tsx` 505、`InputBox.tsx` 512、`commands.ts` 547——均为存量超长文件（DESIGN 声称已拆到 500 以下，实际没有）。本批不做高风险拆文件，按项目例外登记制登记为限时债务（`gates-exceptions.json`，2026-12-31 到期），并让 `gates-check` 从"只校验 no-console"改为校验所有 `rule: off` 的 overrides。拆分任务归入阶段三 3-31 文档/治理批。

**尚未跑**：桌面 Playwright E2E（随 D0-09）。

> 注意：`app-render.test.tsx` 输出了一段 React error boundary 日志，但用例通过；这是测试环境下的既有噪声，暂未追。

## 下一批（建议顺序）

1. **CLI 1-06/1-07/1-10**：`capToolResult` 按 token 重算（附 ASCII/CJK 预算测试）；统一工具内部 cap；预算计入 `toolCalls.args`/图片。理由：这是每个工具调用都命中的"agent 变笨"问题，优先级高于 1-04 的罕见兜底。
2. **CLI 1-04**：压缩熔断后的机械截断兜底（1-03 已让失败可见，但连续失败后仍需要可继续的降级路径）。
3. **补两条集成回归**：`settle-results` 失败前缀（core loop 层）、`host.session/replay` 返回事件（host 层）。
4. **桌面 D0-05**：`close()` await runner、停止后台 bash/子代理；关窗无孤儿。
5. **桌面 D0-06**：planAsker + `plan/request` + ask preview + 超时放宽。
6. **桌面 D0-08**：`sandbox:true` + CSP + 外链白名单 + IPC 发送方校验。
7. **CLI 1-11**：Windows CI 加最小回归。

## 备注

- `packages/tools/src/tools/write.ts` 的越界行为仍是"工具内拒绝"，注释已标为已知取舍；后续按计划把边界上移到权限引擎（越界 → ask），而不是在用户批准后再拒一次。
- `apps/host/src/session.ts` 的 ask 超时仍是 10s（D0-06 处理）；桌面审批在 10s 以上会被自动拒绝，暂未改。
- 桌面 `sandbox:false` / 无 CSP 仍在（D0-08），设置页"渲染层 sandbox 无文件访问"的文案暂时与实现不符，D0-08 一并修正。

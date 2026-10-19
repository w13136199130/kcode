# kcode 桌面端执行方案（2026-10）

> 范围：`apps/desktop`（Electron 主进程/preload/renderer）+ `apps/host`（utilityProcess 宿主），复用 `packages/*` 的同一套会话/权限/工具。
> 关系：这是 [CLI 优化方案](./cli-optimization-plan-2026-10.md) 的并行/后续轨道；**桌面不是第二套 agent**，只是 `composeSession` 的第二个前端。
> 结论先行：现有 desktop 是"可运行的骨架"（M1–M4 已有三栏、虚拟时间线、审批、设置、打包），但 **工作区选择、首次登录、转写重放、计划批准、队列、真实 diff、沙箱/CSP、签名更新** 八处关键能力缺失或失效。补完约 70 人日，2 人 8–10 周可到 V1。
> 实施状态：D0-02（replay）/ D0-03（resume latest）/ D0-07（工作区选择）已开始落地（2026-10-19）；D0 其余待做。记录见 [optimization-log-2026-10-19.md](./optimization-log-2026-10-19.md)。

---

## 0. 结论

### 0.1 现有资产（不要重写）

- 主进程：每窗口一个 `utilityProcess` host、`MessageChannelMain` 直连、reload 重挂端口、3.5s 优雅退出（`apps/desktop/src/main/host.ts`）。
- preload：只暴露端口桥 + 少量 IPC，contextIsolation 已开（`preload/index.ts`）。
- host：`HostServer` 方法路由 + `HostSession` 会话/队列/ask 往返/lease（`apps/host/src/server.ts`、`session.ts`）。
- renderer：三栏布局、虚拟时间线、Shiki Markdown、工具卡、审批四按钮、ask_user、命令面板、主题设置、diff 侧栏、系统通知（17 个组件）。
- 打包：electron-builder NSIS + zip、smoke 模式（`electron-builder.yml`、`main/smoke.ts`）。
- 设计令牌：`@kcode/design` 的 Web CSS 变量与 CLI 同源。

这些是有分量的基础，**V1 不需要从零写 UI**。

### 0.2 但当前不可交付的八个阻断项

1. **没有工作区选择**：默认 cwd 是 `homedir()`（`main/index.ts:102`），桌面打开的是用户主目录，不是项目；没有文件夹选择器，没有最近工作区，标题栏也不显示 cwd。
2. **转写重放是坏的**：`HostSession.replay()` 把 `sessionId` 当文件路径传给 `loadSessionEvents`（`host/session.ts:131`），必然 ENOENT；renderer 的 `.catch(() => undefined)` 把错误吞掉。reload / 切会话后时间线为空。
3. **首次运行死锁**：没有 `~/.kcode/config.json` 时 `getDefaultModel()` 返回 null，`createdRef` 守卫导致**永不建会话**；桌面没有登录/配置 UI，设置页只有主题。
4. **计划模式不可用**：host 创建会话时**没有传 `planAsker`**（`host/session.ts:77-98`），协议里的 `plan/request` 从未发出；`plan_submit` 会报"无交互通道"。
5. **审批无法知情同意**：host 的 `ask/request` 只带 `args`，没有 `preview`；renderer 用 `JSON.stringify(args)` 截 300 字符（`AskPanel.tsx:21-24`）；host 10s 超时自动 deny（`session.ts:25,243-246`）——用户还在读命令就被拒了。
6. **没有队列/steer**：Composer 在 `busy` 时直接禁止发送（`Composer.tsx:40`），`queuedCount` 硬编码 0；host 明明有 `RuntimeCommandQueue`，UI 用不上。
7. **diff 不是 diff**：`DiffViewer` 只是把 `oldString` 全部标 `-`、`newString` 全部标 `+`（`DiffViewer.tsx:15-20`）；write 只显示新增行，不显示旧文件被删；没有逐文件 review/accept/revert。
8. **安全边界与文案不符**：`BrowserWindow` 的 `sandbox: false`（`main/index.ts:43`），设置页却写"渲染层 sandbox 无文件访问"；没有 CSP；Markdown 链接未做 scheme 校验（`RichMarkdown.tsx:160-165`），`javascript:` 可进 renderer；没有 `setWindowOpenHandler` / `will-navigate` 拦截。

### 0.3 判断

**桌面端现在处在"M1–M4 demo 完成、产品化未开始"的阶段。** 继续加视觉/功能会放大返工；先把上面 8 项修掉，再谈三栏细节和动效。

---

## 1. 现状审计（代码实测）

### 1.1 已具备

| 域 | 现状 |
|---|---|
| 进程拓扑 | 每窗口一 host；reload 重挂端口；host 退出通知 |
| 协议 | `host-protocol` 帧 + zod 校验；hello/ready；ask/question/plan 事件词汇；session/create/submit/interrupt/set_mode/set_model/replay |
| 会话 | 宿主侧排队/预约/执行；resume 继承原 ID（host 路径）；lease epoch；ask 断连 fail-closed |
| 渲染 | 三栏、虚拟滚动、live-tail、Markdown+Shiki、工具卡注册制、思考折叠、diff 侧栏、命令面板、设置覆盖层、系统通知 |
| 打包 | NSIS + zip、host 外置、rg staging、无窗口 smoke |
| 测试 | host 集成测试（apps/host/test）、desktop smoke（真实模型 happy path） |

### 1.2 阻断级问题（D-P0）

| # | 问题 | 证据 | 后果 |
|---|---|---|---|
| D-P0-1 | 工作区 = homedir | `main/index.ts:102`；无 dialog；`WorkspaceHeader` 标题硬编码 "kcode" | 用户无法在项目里工作 |
| D-P0-2 | replay 路径错误 + 清空逻辑 | `host/session.ts:131`；`projection.ts:47-48` 遇 `session_start` 清空 rows；`main.tsx:118-128` 吞错 | reload/续接后空白或只剩后半段 |
| D-P0-3 | 首次登录不可达 | `main.tsx:104` 要求 `modelDefault !== null`；`SettingsOverlay` 只有主题；无 `login` 组件 | 新用户进不去 |
| D-P0-4 | plan 未接线 | `host/session.ts` 未传 `planAsker`；`plan/request` 无发送方；renderer 无 plan 面板 | 计划模式不可用 |
| D-P0-5 | 审批信息不足 + 10s 超时 | `session.ts:25,243-246`；`AskPanel.tsx:21-24`；无 `preview` | 看不到完整命令/diff；超时误拒 |
| D-P0-6 | 无队列/steer | `Composer.tsx:40`；`main.tsx:270` `queuedCount={0}` | 运行中只能等或停 |
| D-P0-7 | diff 不是真 diff | `DiffViewer.tsx:15-20`；`ToolCallRow.tsx:66-82` | 无法 review；write 看不到删除 |
| D-P0-8 | 安全边界缺失 | `sandbox:false`；无 CSP；`RichMarkdown.tsx:160-165` 未校验 scheme；无 window-open/navigate 拦截；renderer 可直接 `session/set_mode fullAccess` | XSS 可调到 host 桥；fullAccess 无宿主确认 |

### 1.3 重要缺口（D-P1）

| 域 | 缺口 | 证据 |
|---|---|---|
| 会话 | resume `latest` 不继承原 ID（`#findSessionFile("latest")` 找不到文件）；sessions/list 全局 20 条、无 workspaceKey；无重命名/删除/搜索 | `host/session.ts:58-75,310-316`；`server.ts:137-140` |
| 时间线 | 不渲染 todo/subagent/compaction/permission/skill；`session_start` 清空；row key 用 index | `projection.ts:46-99`；`Timeline.tsx:28` |
| 审批 | 会话级放行仍是整工具；`ask/respond` 超时后 UI 不知道；无键盘确认 | `AskPanel.tsx:41-45`；`host/session.ts:175-187` |
| 生命周期 | `close()` 只 abort，不 await runner、不 stop 后台 bash/subagents；`session/create` 并发无互斥；`#responses` 无上限；通知只找第一个窗口 | `composition.ts:508-513`；`server.ts:52-64`；`main/index.ts:108-126` |
| 安全 | `platform/save_key`、`set_mode` 无发送方校验；无 single-instance lock；无权限请求拒绝；asar 关闭 | `preload/index.ts`；`electron-builder.yml:22` |
| 键盘/可达性 | 无全局 Esc（Composer/Settings 的"Esc"是假的）；无 focus trap；无 ARIA；命令面板只有 7 项 | `main.tsx:75-92`；`SettingsOverlay.tsx:104-106`；`CommandPalette.tsx:32-43` |
| 性能 | 每 delta `setEvents([...prev])` 重渲染；无批量合帧；Shiki 按需但首帧纯文本；长会话全量 replay | `useDesktopConnection.ts:69-73`；`main.tsx:137-162` |
| 测试 | smoke 只覆盖 create/submit/delta/session_end；无 replay/approval/plan/queue/崩溃测试；无 Playwright | `main/smoke.ts:129-156` |
| 打包 | 无签名、无自动更新、无崩溃上报、无图标、asar 关闭 | `electron-builder.yml` |

---

## 2. 目标与边界

### 2.1 目标用户与场景

- Windows 个人开发者，本地项目，BYOK；不想开终端也能完成"读代码 → 改代码 → 跑测试 → 看 diff → 回退"。
- 与 CLI **共享同一会话文件、同一权限语义、同一工具契约**；桌面只是更好的呈现与审批。

### 2.2 V1 必须做到

1. 打开项目文件夹（最近工作区、每窗口独立 cwd）。
2. 首次登录：选厂商 → 填 key → 选模型 → 热生效，不要求手写 JSON。
3. 对话/流式/思考/工具卡/错误；reload 与续接后时间线完整恢复。
4. 审批：完整命令/diff、参数级放行、默认不误放行、键盘可操作、超时不误杀。
5. 计划：plan → 提交 → 批准/修订/放弃 → 切执行。
6. 队列：运行中可继续输入，显示排队数，可中断清空。
7. diff review：改完能看 changed files + hunks，可逐文件回退。
8. 多窗口 = 多会话；关窗优雅退出，无孤儿进程。
9. 签名安装包 + 更新检查 + 崩溃包。
10. 安全基线：renderer sandbox、CSP、IPC allowlist、外链只走系统浏览器、host-only key。

### 2.3 V1 明确不做

- 内置终端/浏览器 pane（N4）
- 插件市场/云同步/分享链接
- 移动端/Web 远程
- 多 agent 并行看板
- 远程 SSH/WSL workspace
- i18n（先中文）
- 自绘标题栏/Lexical 富文本
- 逐行评论式 PR review
- 自定义主题编辑器（先三态）

---

## 3. 目标架构

```
BrowserWindow (sandbox:true, contextIsolation:true, no node, CSP)
  └ preload（只暴露 allowlist IPC + 端口桥）
      └ MessageChannelMain（每窗口一条）
          └ utilityProcess host（1 窗口 = 1 host）
              └ HostServer → HostSession → composeSession
                  ├ JSONL sessions（与 CLI 同目录/同语义）
                  ├ permissions / asker / planAsker
                  ├ tools / MCP / subagents / checkpoints
                  └ platform keychain（key 明文只在 host）
```

硬规则：

1. **renderer 不碰 fs / key / child_process / net**；所有能力经 host RPC。
2. **协议帧 zod 校验 + request id + 幂等缓存 + 能力协商**；renderer 不解析未知事件。
3. **窗口生命周期绑 host**：reload 只重挂端口；关窗 dispose；主进程退出前等 host 结算。
4. **语义只在 packages/\***：resume/压缩/权限/工具修复不得写两份。
5. **全链路可观测**：host 日志、renderer console、崩溃包、审计事件。

---

## 4. 四个阶段（D0–D4）

### D0 共享内核与宿主加固（第 1–2 周，与 CLI 阶段一并行）

> 目标：先把"桌面一用就露馅"的底层问题修掉；不做新 UI。

| ID | 动作 | 落点 | 验收 | 人日 |
|---|---|---|---|---|
| D0-01 | 依赖 CLI 阶段一：resume/压缩/工具错误/预算/CRLF/边界 | `packages/*` | CLI 阶段一出口全绿（桌面自动受益） | — |
| D0-02 | **修 replay**：用 `composed.jsonlPath`；`effectiveEvents` 处理 rewind；replay 时不因 `session_start` 清空；row 用 callId/稳定 id | `apps/host/src/session.ts`、`projection.ts`、`Timeline.tsx` | reload/切会话/续接后时间线完整；rewind 后不复活 | 2 |
| D0-03 | **resume latest 继承原 ID**；`#findSessionFile` 支持 latest/前缀；lease 检查复用 | `host/session.ts` | `-c` 等价、桌面"最近会话"续写同一文件 | 1 |
| D0-04 | **宿主并发/幂等**：create 互斥、pending id 占位、`#responses` LRU 上限、params zod、错误码 | `host/server.ts` | 并发 create 不双开；重复 id 不双执行；缓存不涨 | 1.5 |
| D0-05 | **生命周期**：`close()` await runner、stop 后台 bash/子代理、关 MCP；dispose 语义；关窗 3.5s 兜底 | `composition.ts`、`host/session.ts`、`host.ts` | 关窗/崩溃无孤儿；session_end/usage 落盘 | 2 |
| D0-06 | **ask/plan 接线**：传 `planAsker`；发 `plan/request` + `plan/respond`；ask 带 `preview`；超时改 5min 或断连才 deny；超时发 cancel 事件 | `host/session.ts`、`contracts/host-protocol.ts`、`server.ts` | 计划可批准；审批看完整 diff；超时 UI 有反馈 | 2 |
| D0-07 | **工作区**：`dialog.showOpenDialog` 选目录；最近工作区；每窗口 cwd；标题显示项目名 | `main/index.ts`、`preload`、`WorkspaceHeader` | 打开项目即在该目录建会话 | 1.5 |
| D0-08 | **安全基线**：`sandbox:true`、CSP、`setWindowOpenHandler`、`will-navigate`、外链 `shell.openExternal`、Markdown scheme 白名单、IPC 发送方校验、host 侧 mode 枚举/fullAccess 确认 | `main/index.ts`、`preload`、`RichMarkdown.tsx`、`server.ts` | `javascript:` 链接不执行；新窗口被拦；fullAccess 需宿主确认 | 2 |
| D0-09 | **桌面 E2E 骨架**：Playwright + Electron（或 smoke 扩展）覆盖 replay/resume/approval/plan/queue | `apps/desktop/test`、`scripts` | 5 个场景 CI 可跑 | 2 |

**小计：约 15 人日。** D0 结束前不要动视觉。

**出口标准：**

- [ ] 打开任意项目文件夹 → 会话 cwd 正确。
- [ ] reload / 切会话 / `latest` 续接后时间线完整，rewind 不复活。
- [ ] 审批面板能看完整命令/diff；10s 不再误拒。
- [ ] plan 可批准并切执行。
- [ ] 关窗后无 MCP/后台 bash/子代理残留。
- [ ] `sandbox:true` + CSP 下功能不回归；`javascript:` 链接不执行。

---

### D1 可用骨架（第 3–5 周）

> 目标：新用户能完成"打开项目 → 登录 → 首次任务"。

| ID | 动作 | 落点 | 验收 | 人日 |
|---|---|---|---|---|
| D1-01 | **首次运行引导**：无配置/无 key 时进入 onboarding（不阻塞窗口）；工作区选择 → 厂商预设 → key → 模型 → 保存 | `renderer/Onboarding.tsx`、`main.tsx`、host config RPC | 新机器 3 分钟内完成配置并建会话 | 3 |
| D1-02 | **登录/配置 RPC**：`config/get`、`config/save`（provider 级 merge，保留 budget/其他键）、`provider/probe`、`models/list`；保存后热重建 router | `host/server.ts`、`host/boot.ts`、`platform` | 加第二个 provider 不覆盖第一个；无需重启 | 2.5 |
| D1-03 | **会话侧栏**：按 workspace 分组；新建/续接/重命名/删除；当前会话高亮；时间显示 | `SessionSidebar.tsx`、`sessions/list` | 多项目下只显示当前项目（可切"全部"） | 2 |
| D1-04 | **时间线补全**：todo 面板、subagent 卡、compaction 分隔、permission/skill 提示、错误行；稳定 row key | `projection.ts`、`rows.tsx` | replay 后与 CLI 转写语义一致 | 2 |
| D1-05 | **Composer**：发送/停止、队列计数、运行中可提交、slash 命令菜单、@ 文件补全、模式/模型选择器 | `Composer.tsx`、`main.tsx` | 运行中提交显示排队 N；不丢输入 | 3 |
| D1-06 | **流式合帧**：delta/reasoning 16–33ms 批量入 state；避免逐 token `setEvents` | `useDesktopConnection.ts`、`projection` | 200 tok/s 下 UI 不卡；CPU 可接受 | 1.5 |
| D1-07 | **窗口/标题**：标题 = 项目名；窗口状态记忆；多窗口互不干扰；`requestSingleInstanceLock` | `main/index.ts` | 双窗口两会话；重启恢复窗口位置 | 1 |

**小计：约 15 人日。**

**出口：** 全新 Windows → 打开项目 → 登录 → 首任务 → 审批 → reload 恢复 → 退出，全链路 ≤3 分钟。

---

### D2 信任闭环（第 5–7 周）

> 目标：用户敢让它改文件。

| ID | 动作 | 落点 | 验收 | 人日 |
|---|---|---|---|---|
| D2-01 | **审批完整信息**：bash 完整命令（可滚动）、edit/write 完整 diff（分页/上下文）；默认焦点"拒绝"；键盘 y/n/↑↓/Enter；Esc=拒绝 | `AskPanel.tsx`、`DiffViewer.tsx`、`styles.css` | 100 字符命令/100 行 diff 可完整查看；Enter 不误放行 | 2.5 |
| D2-02 | **参数级放行**：会话级也用 `suggestGrant`；按钮文案显示规则；"允许本会话所有 bash"必须显式 | `AskPanel.tsx`、host `composition` | 允许 `ls` 不放行 `rm -rf` | 1.5 |
| D2-03 | **计划批准**：`plan/request` → 计划卡（Markdown）→ 批准/继续研究/放弃 → 切模式 → 锚点 | `PlanPanel.tsx`、`main.tsx`、host | 计划任务端到端；批准后执行模式正确 | 2 |
| D2-04 | **真实 diff**：host 用 `buildAskPreview`/LCS 生成 unified diff（上下文/行号）；write 对比磁盘旧内容；完成后可 review | `host`、`desc/desktop` renderer | write 能看到删除/新增；不是"全删+全增" | 2.5 |
| D2-05 | **diff review + revert**：`/diff` 面板列 changed files + hunks；逐文件 revert（checkpoint） | `DiffViewer.tsx`、host RPC | 改完不用切 git 就能 review/回退 | 3 |
| D2-06 | **通知**：审批/计划/任务完成/失败；窗口失焦才发；点击聚焦正确窗口；任务栏 badge | `main/index.ts`、`renderer` | 切走后知道在等确认；多窗口通知不串 | 1 |
| D2-07 | **后台任务/子代理**：任务面板、进度、stop；`task_output` 详情 | `TaskPanel.tsx`、host events | 长任务可见可停 | 2 |

**小计：约 14.5 人日。**

**出口：** 写文件任务全链路（审批→执行→diff→回退）；计划任务；后台任务可见；默认不误放行。

---

### D3 日常顺手（第 7–9 周）

| ID | 动作 | 落点 | 验收 | 人日 |
|---|---|---|---|---|
| D3-01 | **设置页**：provider/模型、MCP、skills、权限、主题、快捷键、工作区、关于；保存/热生效 | `SettingsOverlay.tsx`、host config RPC | 不改 JSON 完成常用配置 | 3 |
| D3-02 | **搜索**：会话搜索、转写内查找（Ctrl+F）、文件 @ 搜索 | renderer、host | 长会话能定位 | 2 |
| D3-03 | **命令面板补全**：新建/续接/搜索/设置/导出/主题/模式/停止；模糊匹配；快捷键注册表单一事实源 | `CommandPalette.tsx`、`keymap.ts` | 常用动作都可发现 | 2 |
| D3-04 | **键盘与可达性**：全局 Esc 停止、焦点 trap、ARIA、可见 focus、prefers-reduced-motion | 全局 | 键盘可完成一轮任务 | 2 |
| D3-05 | **导出/打开**：导出 Markdown/JSONL；在文件管理器显示；外链系统浏览器 | renderer、main | 可交付/可排查 | 1.5 |
| D3-06 | **多窗口/会话切换体验**：侧栏切换不闪、不丢草稿；窗口间不串事件 | renderer | 双窗口并行工作 | 1.5 |

**小计：约 12 人日。**

**出口：** 连续 3 天真实项目使用，不需要开终端补配置/看日志。

---

### D4 可交付（第 9–12 周）

| ID | 动作 | 落点 | 验收 | 人日 |
|---|---|---|---|---|
| D4-01 | **安全复审**：sandbox/CSP/IPC/外链/更新/协议 fuzz；更新 threat-model | `docs/threat-model.md`、`main` | 无 P0 发现；XSS/越权用例通过 | 3 |
| D4-02 | **签名与安装**：Authenticode 签名、图标、NSIS + portable、安装/卸载干净 | `electron-builder.yml`、CI | 干净 Windows 安装无 SmartScreen 警告（有证书时） | 3 |
| D4-03 | **更新**：检查 latest.json（或 electron-updater）、提示/下载/安装、回滚；灰度开关 | `main/update.ts` | 旧版可升到新版；失败可回滚 | 3 |
| D4-04 | **崩溃与诊断**：crashReporter、本地崩溃包、`kcode doctor --bundle`、日志脱敏 | `main`、`docs` | 用户可导出诊断；不含 key | 2 |
| D4-05 | **性能**：启动 <2s、首屏 <500ms、1000 行滚动 60fps、内存 <500MB、流式不卡 | 全链路 | 基准测试通过 | 3 |
| D4-06 | **Beta**：10–20 用户、2 周、任务成功率/崩溃率/首次任务耗时；issue 分级 | — | 无阻断级反馈；P0=0 | 2 |

**小计：约 16 人日。**

**出口：** 签名安装包在干净 Windows 上完成"安装→登录→任务→更新→崩溃恢复"；Beta 无 P0。

---

## 5. 与 CLI 的关系与排期

### 5.1 依赖关系

```
CLI 阶段一（共享内核止血，2 周）
        │
        ├── 桌面 D0（宿主/replay/安全，2 周，可与 CLI 阶段一重叠后半）
        │       │
        │       └── D1（3 周）→ D2（2.5 周）→ D3（2 周）→ D4（4 周）
        │
        └── CLI 阶段二/三（可与桌面并行，但人手有限时只做安全/首用）
```

**硬约束**：D0-01 不完成，不要做 D2 的审批/diff——否则 resume/压缩/工具错误会在桌面上重演。

### 5.2 三种排法（按人力选）

| 方案 | 人力 | 周期 | 结果 |
|---|---|---|---|
| **A. 桌面优先（推荐）** | 1 共享/宿主 + 2 桌面 | 12 周 | 桌面 V1 交付；CLI 只做阶段一 + 安全/首用，工具/扩展延后 |
| **B. 双轨并行** | 4 人（1 共享 + 2 桌面 + 1 CLI） | 12–14 周 | 桌面 V1 + CLI 0.4 大部分 |
| **C. CLI 优先** | 2–3 人 | 桌面 20 周+ | CLI 先稳，桌面晚 2 个月 |

> 3 人做"桌面 V1 + CLI 全量阶段二/三"不现实：桌面 V1 约 70 人日，CLI 阶段二/三约 86 人日，合计 156 人日 ≈ 31 人周；3 人 12 周只有 36 人周，扣除联调/返工刚好打平，没有余量。**必须砍 CLI 范围或延长时间。**

### 5.3 建议排期（方案 A，3 人）

| 周 | 共享/宿主（A） | 桌面 UI（B） | 桌面集成/CLI（C） |
|---|---|---|---|
| 1–2 | CLI 阶段一 + D0-02~06 | 设计稿/组件盘点 | D0-07~09（工作区/安全/E2E） |
| 3–4 | D0 收尾 + host 协议测试 | D1-01/03/04（onboarding/侧栏/时间线） | D1-02/05（配置 RPC/Composer） |
| 5–6 | D2-01/02/03（审批/计划） | D1-06/07 + D2-06/07 | D2-04/05（diff/review） |
| 7–8 | D3-04（键盘/可达性） | D3-01/02/03（设置/搜索/面板） | D3-05/06 + CLI 安全/首用 |
| 9–12 | D4-01/04（安全/崩溃） | D4-05 + Beta 反馈 | D4-02/03/06（签名/更新/Beta） |

> C 同时承担 CLI 的 2-13~2-17、2-20~2-24（安全/审批/首用），不接 CLI 工具扩展。

---

## 6. 验收与度量

### 6.1 桌面 E2E（必须新增）

| 场景 | 覆盖 | 阶段 |
|---|---|---|
| `desktop-first-run` | 无 config → onboarding → 登录 → 首任务 | D1 |
| `desktop-workspace` | 选目录 → cwd 正确 → 标题/侧栏 | D0 |
| `desktop-replay` | reload/切会话/latest 续接 → 时间线完整 | D0 |
| `desktop-approval` | 完整命令/diff → 允许/拒绝/本项目 → 参数级 | D2 |
| `desktop-plan` | plan → 提交 → 批准 → 执行 | D2 |
| `desktop-queue` | 运行中提交 → 排队 N → 顺序执行 | D1 |
| `desktop-crash` | kill host → UI 提示 → 新会话 | D4 |
| `desktop-security` | `javascript:` 链接、window.open、外链、fullAccess | D0/D4 |
| `desktop-update` | 旧版 → 新版 → 回滚 | D4 |
| `desktop-multiwindow` | 双窗口两会话互不干扰 | D1 |

### 6.2 指标

- 首次任务耗时（安装→首答）：≤3 分钟。
- 启动：主窗口可交互 ≤2s；首屏 ≤500ms。
- 1000 行时间线滚动 ≥55fps；流式 200 tok/s 无明显掉帧。
- 内存：单窗口空载 ≤250MB；长会话 ≤500MB。
- 关窗后残留进程：0。
- 崩溃恢复：host 崩溃后 5s 内提示；新会话可用。
- 安全：CSP 无 inline script；`sandbox:true`；外链 100% 走系统浏览器；IPC 发送方校验 100%。
- Beta：10–20 用户/2 周；P0=0；任务成功率 ≥80%。

---

## 7. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| `sandbox:true` 破坏 preload/剪贴板/拖拽 | 功能回归 | D0 先试点；preload 只留 electron API；剪贴板走 host RPC |
| CSP 破坏 Shiki/内联样式 | 渲染失败 | `style-src 'unsafe-inline'` 暂留；脚本严格 `'self'`；dev/prod 两套 |
| 签名证书缺失/成本 | SmartScreen 警告 | 先出未签名内测包并明示；签名证书作为发布前置 |
| 自动更新 feed 格式不一致 | 更新失败 | 复用 CLI latest.json 或 electron-updater；先做"检查+下载+提示"，静默替换二期 |
| host/renderer 协议漂移 | 白屏/丢事件 | zod 双向校验 + 协议单测 + 版本协商；未知事件忽略 |
| 多窗口 host 内存/进程 | 资源占用 | 每窗口一 host（既定）；空闲窗口回收二期；先测 3 窗口 |
| 桌面分叉语义 | CLI/桌面行为不一致 | 语义只改 packages/*；renderer 不做业务判断 |
| scope creep（终端/浏览器/市场） | 延期 | 写死 V1 不做清单 |

**回滚**：更新保留上一版安装包 + `latest.json` 可回指；配置写入前备份；host 崩溃不覆盖会话文件（append-only）。

---

## 8. 明确不做（V1）

- 内置终端 / 浏览器 pane
- 插件市场 / 云同步 / 分享
- 远程 SSH/WSL workspace
- 多 agent 看板 / 并行任务编排 UI
- 移动端 / Web 端新功能
- i18n / 遥测上传（先本地诊断）
- 自定义标题栏 / Lexical 富文本
- 逐行评论 / PR review
- 主题编辑器 / 自定义键位

---

## 9. 第一周就做的 10 件事

1. **修 `session/replay`**：用 `composed.jsonlPath` + `effectiveEvents`；replay 不清空。
2. **工作区选择**：`dialog.showOpenDialog` + 最近工作区 + 标题显示项目名。
3. **onboarding/login**：无配置也能进窗口；厂商/key/model 表单；配置 merge。
4. **plan 接线**：`planAsker` + `plan/request` + `plan/respond` + 计划卡。
5. **审批 preview**：host 生成完整命令/diff；10s 改 5min/断连才 deny。
6. **队列**：Composer busy 可提交；显示 `queue/change` 计数。
7. **时间线补全**：todo/subagent/compaction/permission/skill。
8. **真 diff**：host LCS unified diff；write 对比磁盘旧内容。
9. **安全基线**：`sandbox:true`、CSP、外链白名单、链接 scheme 校验、IPC 发送方校验。
10. **E2E 骨架**：Playwright + Electron 覆盖 replay/resume/approval/plan。

---

## 10. 代码证据索引

| 主题 | 文件:行 |
|---|---|
| 默认 cwd = homedir | `apps/desktop/src/main/index.ts:102` |
| sandbox false | `apps/desktop/src/main/index.ts:43` |
| replay 路径错误 | `apps/host/src/session.ts:129-133` |
| session_start 清空 rows | `apps/desktop/src/renderer/components/projection.ts:47-48` |
| 首次运行守卫 | `apps/desktop/src/renderer/main.tsx:102-110` |
| 无 planAsker | `apps/host/src/session.ts:77-98` |
| ask 10s 超时 | `apps/host/src/session.ts:25,238-259` |
| 审批 JSON 300 字符 | `apps/desktop/src/renderer/components/AskPanel.tsx:21-24` |
| busy 禁止发送 | `apps/desktop/src/renderer/components/Composer.tsx:40` |
| queuedCount 硬编码 | `apps/desktop/src/renderer/main.tsx:270` |
| diff 假实现 | `apps/desktop/src/renderer/components/DiffViewer.tsx:15-20` |
| 链接未校验 scheme | `apps/desktop/src/renderer/components/RichMarkdown.tsx:160-165` |
| 设置页 Esc 未实现 | `apps/desktop/src/renderer/components/SettingsOverlay.tsx:104-106` |
| 命令面板仅 7 项 | `apps/desktop/src/renderer/components/CommandPalette.tsx:32-43` |
| close 不清理 | `packages/session/src/composition.ts:508-513` |
| 通知取第一个窗口 | `apps/desktop/src/main/index.ts:108-126` |
| asar 关闭/无签名 | `apps/desktop/electron-builder.yml:19-32` |
| smoke 仅 happy path | `apps/desktop/src/main/smoke.ts:129-156` |

---

## 附：与 CLI 文档的对应

| CLI 项 | 桌面影响 |
|---|---|
| CLI 1-01 resume | 桌面 replay/resume 同源修复（D0-02/03） |
| CLI 1-03 压缩 | 桌面长会话压缩失败同样丢历史（共享） |
| CLI 1-05 工具错误 | 桌面工具卡会显示错误（共享） |
| CLI 2-13~2-17 安全 | 桌面 IPC/链接/沙箱需同步（D0-08/D4-01） |
| CLI 2-20 审批 | 桌面 D2-01/02 |
| CLI 3-23 diff review | 桌面 D2-04/05 |
| CLI 3-27 后台任务 | 桌面 D2-07 |

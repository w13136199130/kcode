# 本地验收指南（优化项怎么测）

> 面向 2026-10 这轮 P0/P1/P2 优化的手工验收。自动化基线是 `pnpm verify`；手工场景用于确认“用起来”符合预期。

## 1. 一键自动化基线

```powershell
pnpm install --frozen-lockfile
pnpm verify
```

`verify` = typecheck → 全量测试 → lint → 依赖边界 → knip → 文档门禁 → build。

当前基线（2026-10-20）：

- `152` 个测试文件 / `780 passed` / `1 skipped`
- `lint` 0 errors；`lint:deps` 0 violations；`knip` / `gates:check` / `build` 通过

只跑某一批：

```powershell
# hooks / CC 协议 / 上下文注入
pnpm vitest run packages/extensions/test/hooks.test.ts packages/core/test/hooks-gates.test.ts

# 插件接线（hooks/permissions/MCP/agents）
pnpm vitest run packages/extensions/test/plugins.test.ts packages/session/test/plugin-wiring.test.ts

# 命令 frontmatter / 命名空间 / !bash
pnpm vitest run packages/extensions/test/commands.test.ts packages/session/test/command-expand.test.ts

# skills 来源策略 / 手动技能
pnpm vitest run packages/extensions/test/skills.test.ts packages/session/test/skill-tool.test.ts

# subagent 扩展
pnpm vitest run packages/extensions/test/agents-library.test.ts packages/session/test/subagent.test.ts

# 费用分项
pnpm vitest run packages/platform/test/usage.test.ts packages/core/test/usage-parts.test.ts apps/cli/test/cost.test.ts

# todo 回注 / task 治理 / 子代理用量
pnpm vitest run packages/core/test/todo-state.test.ts packages/session/test/todo-resume.test.ts packages/tools/test/task-tools.test.ts

# MCP 能力
pnpm vitest run packages/tools/test/mcp.test.ts packages/session/test/mcp-config.test.ts

# 审计 / 保留策略
pnpm vitest run packages/session/test/audit-log.test.ts apps/cli/test/audit-view.test.ts packages/runtime/test/retention.test.ts apps/cli/test/sessions-command.test.ts

# TUI（Ink 交互）
pnpm vitest run apps/cli/test/transcript-view.test.tsx apps/cli/test/tasks-visible.test.tsx apps/cli/test/tool-browser.test.tsx apps/cli/test/input-editing.test.tsx apps/cli/test/terminal-degrade.test.ts
```

## 2. 启动源码 CLI

```powershell
pnpm --filter @kcode/cli start
```

需要真实模型时先按 README 配置 `~/.kcode/config.json`；只验 TUI/命令面时，进入后直接 `/help`、`/hooks`、`/skills`、`/mcp`、`/status`。

子命令（不进 TUI）：

```powershell
pnpm --filter @kcode/cli start -- sessions vacuum --dry-run
pnpm --filter @kcode/cli start -- sessions list
pnpm --filter @kcode/cli start -- doctor
```

## 3. 手工场景

### 3.1 hooks：matcher + 上下文 + CC 配置

1. 建脚本 `~/.kcode/hook-demo.mjs`：

```js
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  console.log(JSON.stringify({ action: "allow", additionalContext: "来自 hook 的上下文" }));
});
```

2. `~/.kcode/hooks.json`：

```json
{ "hooks": [{ "event": "pre_tool_use", "matcher": "^bash$", "command": "node \"C:/Users/<你>/.kcode/hook-demo.mjs\"" }] }
```

3. 启动后 `/hooks` 应显示 `[^bash$]`；让模型跑一次 bash，再问“复述 hook_context”，应能看到注入内容。
4. CC 形态验证：把 hooks.json 换成 `{"hooks":{"PreToolUse":[{"matcher":"^bash$","hooks":[{"type":"command","command":"node \"...\"","timeout":5}]}]}}`，`/hooks` 仍能加载。

### 3.2 命令 frontmatter / `!bash` / 命名空间

项目内建 `.kcode/commands/team/deploy.md`：

```markdown
---
description: 部署到目标环境
argument-hint: "<env>"
---
!`echo deploy-$ARGUMENTS`
请总结部署输出：$ARGUMENTS
```

启动后：

- `/help` 里应出现 `team:deploy` 与描述/参数提示；
- `/team:deploy prod` 展开结果应包含 `deploy-prod`，且**不能**看到 `---` 或原始 `!` 语法。

### 3.3 skills：项目/插件默认手动

项目内建 `.kcode/skills/code-review/SKILL.md`（带 `triggers: [审查]`）：

- 输入“帮我审查一下”，**不应**自动注入正文（📖 不出现）；
- `/skills` 应显示该技能为“（手动）”；
- `/skill code-review` 应能手动注入。

把同一技能放到 `~/.kcode/skills/`（用户级），再次输入“审查”才应自动触发。

### 3.4 插件接线

```powershell
pnpm --filter @kcode/cli start -- plugin install <插件目录>
```

同意摘要应列出 hooks/MCP/子代理；安装后：

- `/hooks` 显示“插件 <name>”；
- `/mcp` 能看到插件 MCP；
- 插件 `permissions` 只接受 `<工具>:ask|deny`，写 `allow` 应在安装期被拒。

最快回归：`pnpm vitest run packages/session/test/plugin-wiring.test.ts`（会真实安装临时插件并断言 hook cwd 与 `read:deny`）。

### 3.5 subagent：plan 档只读

1. Shift+Tab 切到 plan；
2. 让模型“用 task explore 调研…”——应成功；
3. 让它“用 task general-purpose 写文件”——应返回 `plan（只读）档只能派生只读子代理`。

### 3.6 费用 / 审计 / todo

- 跑几轮工具后 `/cost`：应看到缓存命中/写入、推理 token（厂商回报时）、按模型与工具、子代理分项；
- `/audit 20`：应看到工具、裁决、scope、耗时；
- 文件核对：
  - 会话：`~/.kcode/cli/sessions/<sessionId>.jsonl`
  - 审计：`~/.kcode/cli/audit/<sessionId>.jsonl`
- 让模型用 `todo` 建清单，下一轮问“当前任务清单”，应答出 `<todo_state>` 内容；重启 `--resume` 后清单仍在。

### 3.7 MCP 能力

项目内 `.kcode/mcp.json`（先 `/trust`）：

```json
{ "servers": [{ "name": "fs", "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }] }
```

- `/mcp` 应显示已连接与工具；
- 声明 `annotations.readOnlyHint` 的工具在 plan 档可调用；
- 调用过程中按 Esc 应立即取消等待（不再等 60s 超时）；
- 断开服务器后下一次调用应自动重连一次。

### 3.8 保留策略

```powershell
pnpm --filter @kcode/cli start -- sessions vacuum --dry-run
pnpm --filter @kcode/cli start -- sessions vacuum --max-sessions 50 --max-age-days 30
pnpm --filter @kcode/cli start -- sessions rm <id>
```

`--dry-run` 只打印计划；`rm` 后对应 `artifacts/<id>`、`checkpoints/<id>`、`audit/<id>.jsonl` 应一并消失。

### 3.9 终端安全 / 降级

```powershell
$env:NO_COLOR="1"; $env:KCODE_PLAIN="1"; pnpm --filter @kcode/cli start
```

状态符应为 ASCII、无颜色；粘贴含 ESC/OSC 的文本不会改窗口标题或写剪贴板（自动化见 `sanitize.test.ts` / `terminal-degrade.test.ts`）。

### 3.10 排队输入（3-33）

1. 发起一轮长任务（或任务进行中），连续输入 `q2`、`q3`；
2. 输入框上方应出现 `⧗ 排队 N 条` 面板，逐条显示预览；
3. 运行中输入 `/mode plan`：应立即切到只读，不出现新的排队项；
4. 按 Esc：应提示“队列保留 N 条”，队列进入“已暂停”，不会自动续跑；
5. 输入 `/queue` 查看、`/queue rm 1` 删除、`/queue run` 恢复执行、`/queue clear` 清空。

自动化回归：

```powershell
pnpm vitest run apps/cli/test/queue.test.tsx packages/runtime/test/command-queue.test.ts
```

### 3.11 复制与失败输出（3-34）

1. 让模型输出一段带代码围栏的回复；
2. `/copy` 应提示复制最近回复；`/copy code` 应提示复制代码块（含语言与行数）；
3. 触发一个失败工具（如 `bash` 跑不存在的命令）：失败卡应直接显示末尾 6 行错误，无需 Ctrl+O；当前轮按 Ctrl+O 展开 12 行，Ctrl+B 看完整输出（旧轮次已进 Static，用 Ctrl+B / `/export`）。

自动化回归：

```powershell
pnpm vitest run apps/cli/test/copy.test.ts apps/cli/test/transcript-view.test.tsx apps/cli/test/transcript.test.tsx
pnpm vitest run packages/core/test/compaction-boundary.test.ts
```

### 3.12 配色/对比度（3-35）

```powershell
pnpm vitest run packages/design/test/contrast.test.ts packages/design/test/tokens.test.ts
```

自动校验暗色（#0c0c0c 底）与亮色（#ffffff 底）所有语义色 ≥ 4.5:1，且状态色必须为确定性 hex。手工检查：

```powershell
$env:KCODE_THEME="light"; pnpm --filter @kcode/cli start   # 白底可读
$env:KCODE_THEME="dark";  pnpm --filter @kcode/cli start   # 深底可读（默认）
$env:KCODE_PLAIN="1";     pnpm --filter @kcode/cli start   # ASCII + 无色
```

> `KCODE_THEME=light` 只切前景色，不切终端背景。测 light 前先把终端 color scheme 设为浅色（One Half Light / Solarized Light），否则深蓝字会在黑底上发暗。

重点看：状态栏、工具失败卡、diff +/-、审批面板的提示色；浅色下不应出现浅黄/浅绿低对比文字。

### 3.13 Ctrl+K 命令面板（3-36）

1. 空闲输入区按 `Ctrl+K`，应弹出“命令面板”；
2. 输入 `copy` 过滤到 `/copy`，`↑↓` 切换、`Enter` 执行（无参数命令直接执行；需要参数的命令回填 `/name `）；
3. 输入 `工具` 应命中“打开工具浏览器”等键动作；
4. `Esc` 或再按 `Ctrl+K` 关闭。

自动化回归：

```powershell
pnpm vitest run apps/cli/test/command-palette.test.tsx
```

### 3.14 项目策略文件（4-02）

1. 在项目根建 `.kcode/policy.json`：

```json
{ "version": 1, "rules": [
  { "tool": "bash", "commandPrefix": ["rm -rf /", "git push --force", "del /s"], "decision": "deny", "priority": 100 }
] }
```

2. 新会话应提示“已加载项目策略 N 条”；
3. 让模型执行 `bash` `rm -rf /`（或直接问）应返回 permission denied，命令不执行；
4. 复合命令 `echo ok && rm -rf /`、`sudo -u root rm -rf /` 也应被拒绝；
5. 把 JSON 改坏后新会话应 fail-closed（全部工具拒绝）并提示修复；删除文件恢复正常。

自动化回归：

```powershell
pnpm vitest run packages/extensions/test/policy.test.ts packages/session/test/policy-wiring.test.ts
```

### 3.15 srt 沙箱（4-01，实验）

> srt Windows 是 alpha；安装会创建 `srt-sandbox` 本地账户和机器级 WFP 过滤器，需要一次 UAC。只在测试机尝试。

1. 安装（脚本默认 `--skip-profile-grant`，不授予 profile 读）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/srt-sandbox.ps1 -Action install
```

2. 启动并查看：

```powershell
$env:KCODE_SANDBOX="srt"
$env:KCODE_SANDBOX_MODE="workspace-write"
# pnpm --filter 默认 cwd 是 apps/cli；从仓库根显式指定项目根
pnpm --filter @kcode/cli start -- --cwd "$PWD"
```

3. `/sandbox` 应显示 `srt ✅`；
4. 让模型执行 `echo ok > sandbox-write.txt` 成功；写 `C:\Windows\...` 失败；`curl https://example.com` 失败；
5. `/audit 10` 应能看到 bash 记录的 `sandbox=srt/workspace-write`；系统目录写失败应带 `denied=path:`（网络拒绝可能只在命令输出里，不保证结构化 denied）；
6. 再测 `git status`、`node -v`、`pnpm -v`；若被 ACL 挡，先记录具体命令，不要关闭沙箱掩盖；
7. 关闭 `KCODE_SANDBOX` 后行为恢复；验收/回滚：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/srt-sandbox.ps1 -Action verify
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/srt-sandbox.ps1 -Action uninstall
```

自动化（不需要安装 srt）：

```powershell
pnpm vitest run packages/sandbox/test/router.test.ts packages/sandbox/test/policy.test.ts packages/tools/test/bash-sandbox.test.ts
pnpm vitest run apps/cli/test/terminal-panel.test.tsx
```

`/terminal` 打开交互终端（Ctrl+] 退出）：MXC 可用时是受保护 PTY；srt 下明确回退普通 PTY，不受 srt 保护，不要用它执行不可信代码。

### 3.16 全局只读访问模式（AccessMode）

```powershell
$env:KCODE_ACCESS_MODE = "read-only"
pnpm --filter @kcode/cli start -- --cwd "$PWD"
```

1. `/sandbox` 应显示 `访问模式：read-only`；
2. 让模型调用 `write` / `edit` / `apply_patch` / `bash`，应全部 permission denied；
3. `!` 直执行应被拒绝；`/terminal` 应提示禁止；
4. 只读工具（read/glob/grep/web_fetch/todo 等）仍可用；
5. 取消 `KCODE_ACCESS_MODE` 后恢复正常。

这个模式与 `KCODE_SANDBOX_MODE` 正交：前者管所有工具，后者只管 srt 的 bash 写权限。

### 3.17 诊断工具（4-03）

显式工具：

```text
让模型调用 diagnostics
```

应返回 `[tsc exit=...]` / `[eslint exit=...]` / `[pyright exit=...]` 与诊断正文；没有本地配置时返回“未检测到可用的诊断命令”，不会 npx 下载。

自动回灌：

```powershell
$env:KCODE_DIAGNOSTICS = "auto"
pnpm --filter @kcode/cli start -- --cwd "$PWD"
```

让模型修改一个带类型错误的 `.ts` 文件；write/edit 成功后，工具结果尾部应出现：

```text
<diagnostics>
── [tsc exit=1] @ ...
C:\...\a.ts:1:1 error: TS...: ...
（项目其它文件 N 条已过滤）
</diagnostics>
```

也可以显式指定单个文件（只显示该文件诊断）：

```text
diagnostics path=src/a.ts
```

自动化：

```powershell
pnpm vitest run packages/tools/test/diagnostics.test.ts
```

### 3.18 repo map（4-04）

1. 启动后让模型回答“这个仓库有哪些模块/入口”，观察是否直接引用 repo map，而不是先盲搜；
2. 显式调用：

```text
repo_map
```

应返回目录/文件/符号摘要；`repo_map path=src maxChars=2000 refresh=true` 可限范围/预算并绕过 30s 缓存；
3. `KCODE_REPO_MAP=off` 重启后系统提示不再注入 `<repo_map>`；
4. repo map 默认忽略 `node_modules/.git/dist/build/.next/coverage`。

自动化：

```powershell
pnpm vitest run packages/tools/test/repo-map.test.ts
```

### 3.19 会话 fork/搜索（4-05）

1. `/fork`：当前会话历史带入新分支，新 sessionId/新 JSONL，原会话保留；
2. `/fork latest` 或 `/fork <id 前缀>`：从历史会话开分支；
3. `kcode --fork latest`：启动时直接 fork；
4. `/search 部署`：跨会话 JSONL 搜索，按会话分组显示 sessionId、标题、行号、正文 snippet 与来源标签；结果中不应出现 `callId`/`type`/`uuid` 等 JSONL 元数据；
5. `/sessions rm <id>`：删除历史；删除当前会话应被拒绝；
6. `/rename 标题`：已有能力，搜索结果的 title 应反映新标题。

自动化：

```powershell
pnpm vitest run packages/runtime/test/resume.test.ts apps/cli/test/session-fork.test.ts apps/cli/test/args.test.ts
```

### 3.20 消息级编辑/重发（4-06）

1. `/retry`（无参数）列出当前会话可编辑/重发的提问轮次；
2. `/retry 2`：回退到第 2 轮提问之前（恢复文件检查点、截断后续事件），再发送原提问；
3. `/edit 2 新的问题`：回退后发送编辑后的内容；
4. TUI 内 `/edit`（无参数）：打开提问选择面板 → 选中后进入编辑面板，预填完整文本；Enter 提交重发、Ctrl+J 换行、Esc 取消；
5. 运行中应拒绝；回退后 `/rewind` 清单应只保留有效前缀；
6. 检查点行为与 `/rewind` 相同：该轮之后的写/编辑文件会恢复。

自动化（消息索引/截断由现有 rewind 覆盖）：

```powershell
pnpm vitest run packages/session/test/plan-rewind.test.ts apps/cli/test/session-fork.test.ts
```

### 3.21 Rules / 项目记忆（4-07）

1. 用户规则：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.kcode\rules"
@"
---
alwaysApply: true
---
回答用中文，先读代码再改。
"@ | Set-Content "$env:USERPROFILE\.kcode\rules\global.md"
```

重启后系统提示应包含该规则；`/rules` 不是命令，让模型调用 `rules` 工具查看索引。

2. 项目路径规则：

```powershell
New-Item -ItemType Directory -Force .kcode\rules
@"
---
description: React 组件规范
paths:
  - "src/components/**/*.tsx"
---
组件使用命名导出。
"@ | Set-Content .kcode\rules\react.md
```

项目必须已 `/trust`；让模型调用：

```text
rules path=src/components/Button.tsx
```

应只返回命中规则，不命中时返回“没有命中”。

3. 项目记忆：

```text
memory action=add text=提交前先跑 lint
memory action=list
```

记忆写入 `~/.kcode/projects/<key>/memory/notes.md`；新会话启动应自动注入 `<memory>`。

4. `KCODE_RULES=off` / `KCODE_MEMORY=off` 重启后对应块消失；未 trust 项目不应加载 `.kcode/rules`。

自动化：

```powershell
pnpm vitest run packages/session/test/rules.test.ts
```

### 3.22 插件签名（4-08）

1. 生成密钥：

```powershell
kcode plugin keygen .keys
```

2. 签名插件目录：

```powershell
kcode plugin sign .\my-plugin --key .keys\kcode-plugin.key
```

3. 不信任密钥直接安装签名插件：应报“未受信任”；
4. 信任后安装：

```powershell
kcode plugin trust .keys\kcode-plugin.pub "测试"
kcode plugin install .\my-plugin
```

5. `kcode plugin list` 应显示 `✍ <keyId>`；
6. 篡改缓存里的插件文件后重开会话：应拒绝装载并告警；
7. `kcode plugin install .\my-plugin --require-signature` 对未签名插件应拒绝；
8. `KCODE_PLUGIN_REQUIRE_SIGNATURE=1` 下未签名插件装载应失败。

自动化：

```powershell
pnpm vitest run packages/extensions/test/plugin-signing.test.ts packages/extensions/test/plugins-state.test.ts
```

真实适配器（需已安装；一次性，opt-in）：

```powershell
$env:KCODE_SRT_LIVE="1"
pnpm vitest run packages/sandbox/test/srt-live.test.ts
```

模块划分与已知限制见 [srt-sandbox.md](./srt-sandbox.md)。

## 4. 结果怎么看

- 自动化通过但手工异常：优先抓 `~/.kcode/cli/sessions/<id>.jsonl` 与 `~/.kcode/cli/audit/<id>.jsonl`；
- `/audit` 看“谁在何时允许了什么”；`/cost` 看 token 去哪了；
- TUI 异常先试 `KCODE_PLAIN=1` 排除颜色/控制序列因素；
- Windows 特有问题（路径、CRLF、进程树、DPAPI、剪贴板）在 Windows 上跑全量即可复现，CI 的 `windows` job 也是全量。

## 5. CI

推送后打开 GitHub Actions：

- `gates`：Linux 全门禁 + build；
- `windows`：Windows 全量测试 + desktop E2E。

首次 Actions 运行需要仓库已推送；本地以 `pnpm verify` 为准。

# CLI 编码 Agent 能力对标（2026-10 快照）

面向 **kcode**（自研本地 CLI 编码 Agent，TypeScript + Ink，BYOK 多厂商，Windows 优先）的竞品能力基线。
只讨论**终端 CLI/TUI 形态**；桌面 / Web / IDE 插件本体不作为对标对象，但"IDE 集成（ACP/LSP/IDE 桥）"作为 CLI 能力计入。

---

## 0. 快照与方法说明

- **采样时间**：2026-10-19。所有结论基于当次抓取的官方文档原文，文中附 URL。
- **证据等级**：
  - `[原文]` 直接读到官方文档正文；
  - `[索引]` 只读到官方文档站点的目录/页面存在性（导航或 llms.txt），未读正文，措辞已相应收敛；
  - `[镜像]` OpenAI Codex 文档站 `developers.openai.com` 对本环境返回 403，改用其 Mintlify 托管镜像 `mintlify.wiki/openai/codex/*.md`（页面标注 generated 2026-02-28，commit `6a673e7`），并在正文给出官方路径。
- **重要状态变化（会影响对标对象选择）**：
  - Gemini CLI 文档站顶部横幅：**免费层与 Google One 用户自 2026-06-18 起被 Antigravity CLI 取代**，且 Gemini CLI 未针对 Gemini 4 Argon 优化。见 <https://geminicli.com/docs/>。→ 对标 Gemini CLI 时应视为"仍在维护但已非 Google 主推入口"。
  - OpenCode 仓库已从 `sst/opencode` 迁移到 `anomalyco/opencode`，且存在 **OpenCode 1 / OpenCode 2 两条线不能并存安装**（`opencode` 命令冲突）。见 <https://opencode.ai/docs/>。
  - Claude Code 已从"CLI + 若干集成"演化成"CLI + 后台会话守护进程 + 云会话 + Agent SDK"的多形态产品，CLI 仍是主入口。

---

## 1. 对标产品与证据源

| 产品 | 形态定位（官方说法/事实） | 主要证据源 |
|---|---|---|
| **Claude Code** | 终端为主入口的 agentic coding tool，另有 Desktop/Web/IDE/Slack；CLI 含后台会话、云会话、Agent SDK | <https://code.claude.com/docs/en/cli-reference>、<https://code.claude.com/docs/en/memory>、<https://code.claude.com/docs/llms.txt> |
| **OpenAI Codex CLI** | Rust 实现，`codex`（TUI）/`codex exec`（无头）/`codex review`；thread/turn/item 原语 + app-server | <https://developers.openai.com/codex>（403，镜像：<https://mintlify.wiki/openai/codex/concepts/overview.md>、<https://mintlify.wiki/openai/codex/concepts/non-interactive-mode.md>） |
| **Google Gemini CLI** | Node/Ink 实现，`-p` 无头、扩展/技能/策略引擎；ACP 模式供 IDE 接入 | <https://geminicli.com/docs/>、<https://geminicli.com/docs/cli/headless/>、<https://geminicli.com/docs/cli/checkpointing/>、<https://geminicli.com/docs/reference/policy-engine/> |
| **OpenCode** | Go/单二进制 + TUI，核心卖点是 `serve`/`web`/`attach`/`acp`/SDK 的"客户端-服务端"架构 | <https://opencode.ai/docs/cli/>、<https://opencode.ai/docs/permissions/>、<https://opencode.ai/docs/> |
| **Aider** | Python，"AI pair programming in your terminal"，文件入 chat + git 提交为每次改动兜底 | <https://aider.chat/docs/usage.html>、<https://aider.chat/docs/usage/commands.html> |
| **Cursor CLI** | `agent` 二进制，`-p` print 模式，模式与编辑器对齐（Agent/Plan/Ask），可 `&` 转交 Cloud Agent | <https://cursor.com/docs/cli/overview>、<https://cursor.com/docs/cli/headless>、<https://cursor.com/docs/cli/acp> |
| **Qwen Code** | Gemini CLI 同源代码线，功能面已扩展到 daemon/serve、多语言 SDK、IM channels、computer use | <https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/>、<https://qwenlm.github.io/qwen-code-docs/en/users/overview/> `[索引]` |
| **Goose**（Block→AAIF） | Rust，CLI + Desktop；recipes/schedules/plugins/extensions 是核心差异化 | <https://goose-docs.ai/docs/guides/goose-cli-commands/> |
| **Zed ACP**（协议侧） | 编辑器侧的 Agent Client Protocol 注册表与外部 agent 托管规范 | <https://zed.dev/docs/ai/external-agents>、<https://agentclientprotocol.com> |

---

## 2. 维度 1：入口与脚本化

### ■ 共有基线（没有就算缺）

1. **默认 TUI + 位置参数一次性 prompt**：`claude "q"` / `codex "q"` / `gemini "q"` / `opencode --prompt` / `aider file` / `agent "q"`。
2. **无头/打印模式**：`claude -p`、`codex exec`、`gemini -p`、`opencode run`、`goose run -t`、`agent -p`。Aider 以 `--message` 承担。
3. **stdin 管道**：`cat logs.txt | claude -p "explain"`；`echo ... | codex exec`；`codex exec -`（heredoc）。
4. **机器可读输出**：至少一路 JSON/JSONL 事件流。
   - Claude `--output-format text|json|stream-json`（+ `--include-partial-messages`、`--replay-user-messages`）<https://code.claude.com/docs/en/cli-reference>
   - Codex `--json`（`turn/started`、`item/agentMessage/delta`、`turn/completed` 等 JSONL）<https://mintlify.wiki/openai/codex/concepts/non-interactive-mode.md>
   - Gemini `--output-format json|stream-json`（init/message/tool_use/tool_result/error/result 事件）<https://geminicli.com/docs/cli/headless/>
   - OpenCode `run --format json`；Goose `--output-format text|json|stream-json`。
   - Aider 缺（仅人类可读 + git 提交），**这是 Aider 的老化点**。
5. **语义化退出码**：Codex 最完整（0 成功 / 1 通用 / 2 认证 / 3 配置 / 4 模型 API / 130 Ctrl-C）；Gemini 有 0/1/42（输入错误）/53（turn 超限）；Claude 至少 `auth status` 与 `ultrareview` 定义 0/1。
6. **会话可续跑于无头模式**：`claude -c -p`、`codex exec resume --last`、`opencode run -c/-s`、`goose run -r`。
7. **子命令面**：`auth`、`models`、`mcp`、`session`、`update/upgrade`、`--version` 至少各一。
8. **CI 场景有官方配方**：Codex（GitHub Actions / GitLab / Jenkins 示例）、Claude（GitHub Actions、GitLab CI 文档）、OpenCode（`github install` 生成 workflow）。
9. **非 TTY 自动降级**：Gemini 明确"非 TTY 或给 `-p` 即 headless"。

### ◆ 加分项

- **结构化输出约束**：Claude `--json-schema`；Codex `--output-schema schema.json`（最终消息符合 schema）。这是"把 agent 塞进流水线"的关键。
- **预算/轮次闸门**：Claude `--max-turns`、`--max-budget-usd`（子代理消耗计入上限）；Goose `--max-turns`、`--max-tool-repetitions`。
- **不落盘运行**：Codex `--ephemeral`、Claude `--no-session-persistence`、Goose `--no-session`。
- **常驻服务避免冷启动**：OpenCode `serve` + `run --attach`（官方理由即"MCP 冷启动"）、`attach` 远程 TUI；Qwen `qwen serve` + REST/SSE + 三语言 SDK `[索引]`。
- **后台会话托管**：Claude `--bg/--background`、`claude agents --json`、`attach/logs/stop/respawn/rm`、`claude daemon run|status|stop`、`--exec`（PTY 后台跑 shell）。
- **快启动模式**：Claude `--bare`（跳过 hooks/skills/MCP/CLAUDE.md 自动发现）；`--safe-mode` 反向用于排障。
- **隔离评测模式**：Claude `--restricted`（禁命令/代码执行工具、只读文件、只用 managed settings、拒绝 bypassPermissions），专为"共享机器上的评测 harness"设计。
- **一次性长任务入口**：Claude `claude ultrareview <pr> --json`、`claude -p --environment ccpool_*`（云/自托管环境）。

### 各家实现差异

| 能力点 | Claude Code | Codex CLI | Gemini CLI | OpenCode | Aider |
|---|---|---|---|---|---|
| 无头入口名 | `-p/--print` | `exec`（+`review`） | `-p/--prompt` | `run` | `--message` |
| JSONL 事件 | `stream-json` 含 tool_use/hook 事件 | `--json`，thread/turn/item 语义 | `stream-json` 六类事件 | `--format json` | 无 |
| schema 约束输出 | `--json-schema` | `--output-schema` | 未见 | 未见 | 无 |
| 退出码语义 | 少量（0/1） | **最完整**（含 2/3/4/130） | 有 42/53 特色码 | 未文档化 | 基本 0/1 |
| 常驻服务 | daemon（后台会话） | app-server（JSON-RPC，thread/*） | 无（ACP 模式替代） | **`serve`/`web`/`attach`** | 无 |
| SDK | Agent SDK（TS/Py）+ 结构化输出 + 成本追踪 | app-server API | 无独立 SDK | **SDK + HTTP Server API** | Python API（scripting 文档） |

**结论**：无头模式的"及格线"已从"能 `-p` 出一段文本"上移到 **"JSONL 事件流 + 语义退出码 + 可续跑 + schema 输出"**。kcode 若只有 `--print`，在 CI 场景属于 2024 年水平。

---

## 3. 维度 2：会话

### ■ 共有基线

1. `--continue`（续最近一次）与"按 ID 恢复"两条路径都在。
2. 交互式会话选择器（Claude `--resume` 无参开 picker；Codex `codex resume`；OpenCode `session list`；Goose `session list`）。
3. 会话命名（Claude `-n/--name` + `/rename`；Goose `-n` + `session rename`；OpenCode `--title`）。
4. 落盘可寻址：Claude `.jsonl` transcript（`--resume` 可直接吃 `.jsonl` 路径）；Codex `~/.codex/sessions` 的 JSONL rollout；Goose 1.10 起 SQLite `sessions.db`。
5. 清空/删除（`/clear`、`/reset`、`session delete`、`session remove`）。
6. 上下文压缩入口（Claude `/compact` + `--autocompact 500k`；Aider `/tokens` + repo map 预算；其余为自动压缩）。

### ◆ 加分项

- **fork/分支**：Claude `--fork-session`；Codex `thread/fork`；OpenCode `--fork`；Goose `--resume --fork`。
- **删除/回滚文件改动**：
  - Claude `/rewind` + checkpointing 文档 <https://code.claude.com/docs/en/checkpointing>
  - Gemini `/restore`：**影子 git 仓库** `~/.gemini/history/<project_hash>`，恢复文件 + 对话 + 重放待执行工具调用，默认关闭需 settings 开启 <https://geminicli.com/docs/cli/checkpointing/>
  - OpenCode `/undo` `/redo`（可多次）
  - Aider `/undo` = 撤销 aider 自己做的 git commit
- **PR 关联恢复**：Claude `--from-pr 123` 打开"创建过该 PR 的会话"；粘贴 PR URL 到 `/resume` 也能命中（2026-w18 周报）。这是"会话以交付物为索引"的思路，Codex/Gemini 未见。
- **跨项目**：Claude `--resume <id>` 会先搜当前项目与 worktree，再搜"本机所有其他项目"；`Ctrl+R` 跨全部项目搜历史（2026-w19）。
- **导出/导入**：OpenCode `export [--sanitize]` / `import <file>`；Goose `session export --format markdown|json|yaml`；Claude 会话导出（sessions 文档 `[索引]`）；Aider `/copy-context` 导出 markdown 供网页对话。
- **会话内容可视化编辑**：Goose `--edit` 把对话以 YAML 在 `$EDITOR` 打开，可裁剪后再续（还能配 `--fork`）。
- **诊断包**：Goose `session diagnostics` 产出含版本/OS/消息/配置/日志的 JSON。
- **后台会话即会话**：Claude 后台会话出现在 `--resume` picker 里并标 `bg`，可 `attach` 到当前终端接管。

### 差异表

| 能力 | Claude Code | Codex | Gemini | OpenCode | Goose | Aider |
|---|---|---|---|---|---|---|
| 续跑 | `-c` / `-r id|name|picker` | `resume [--last|id]` | 会话管理文档 | `-c/-s/--fork` | `--resume` | `--restore-chat-history` `[索引]` |
| fork | ✅ | ✅ `thread/fork` | 未见 | ✅ | ✅ | ❌ |
| 文件级回滚 | `/rewind` | ghost snapshots 配置项 | **`/restore` 影子 git** | `/undo` `/redo` | ❌（git 自理） | `/undo`（git commit） |
| 导出 | 有（transcript 导出） | JSONL 原始文件 | 未见 | ✅ JSON + 脱敏 | ✅ 三格式 | `/copy-context` |
| 会话搜索 | **跨项目 + 历史全文** | ❌ | ❌ | ❌ | 按目录/limit/regex 删 | ❌ |

**结论**：会话层已分化为两派——"**消息/文件快照派**"（Claude `/rewind`、Gemini 影子 git、OpenCode undo）与"**git 兜底派**"（Aider）。kcode 若无 checkpoint，用户第一次被改坏文件就会流失。

---

## 4. 维度 3：上下文与记忆

### ■ 共有基线

1. **项目指令文件**：`AGENTS.md`（Codex/OpenCode/Goose/Qwen/Cursor）、`CLAUDE.md`（Claude）、`GEMINI.md`（Gemini）、`.cursor/rules`。
2. **分层**：全局（家目录）+ 项目根 + 子目录，且**子目录按需加载**而非启动全量加载。
3. **`@` 文件引用与模糊搜索**（OpenCode `@` fuzzy；Claude `@path` import；Codex `@` mention 类）。
4. **图片输入**（拖拽或 `-i`）；PDF 在 Claude 侧明确支持（memory/多模态文档）。
5. **上下文用量可见**：Claude `/context` + statusline；Aider `/tokens`；OpenCode `stats`；Gemini 有 context 相关教程页。
6. **手动压缩 + 自动压缩**。

### ◆ 加分项（这一维度是 2026 年差距最大的地方）

- **指令层级做到"托管策略级"**：Claude 五层——managed policy（`/etc/claude-code/CLAUDE.md`、`C:\Program Files\ClaudeCode\CLAUDE.md`）/ user `~/.claude/CLAUDE.md` / project / local `CLAUDE.local.md` / 子目录按需；且**按 load order 拼接而非覆盖**。<https://code.claude.com/docs/en/memory>
- **路径作用域规则**：`.claude/rules/*.md` + `paths:` frontmatter（glob，含 brace expansion，1000 pattern/4MiB 预算），只在读写匹配文件时才加载。
- **递归 import**：CLAUDE.md 支持 `@path` 导入，最多 4 跳；外部路径首次需批准。
- **自动记忆（auto memory）**：Claude 默认开启，四类 `user/feedback/project/reference`，落在 `~/.claude/projects/<project>/memory/`，含 `MEMORY.md` 索引（**每次会话只加载前 200 行或 25KB**），`/memory` 可浏览/编辑，`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 可关；子代理可有独立 memory。Gemini 有 Auto Memory（🔬，<https://geminicli.com/docs/cli/auto-memory/>），Codex 有 `memories` 配置段。
- **与竞品指令文件互操作**：Claude 默认"有 CLAUDE.md 就不读 AGENTS.md"，可用 `/config` 的 Project instructions 切成 `claude-md-and-agents-md` 同时读；`/init` 会吸收 `.cursor/rules`、`.github/copilot-instructions.md`，`/import` 可搬入 codex 等 agent 的配置。
- **ignore 语义**：Gemini `.geminiignore`、Qwen `qwen-ignore`、Aider `.aiderignore`（`[索引]`）。
- **指令文件体检**：Claude `/doctor prompt-audit` 找过期/冲突指令；`/init` 建议而非覆盖。

### 差异表

| 能力 | Claude Code | Codex | Gemini | OpenCode | Aider |
|---|---|---|---|---|---|
| 指令文件 | CLAUDE.md（兼容 AGENTS.md） | **AGENTS.md 三级合并** | GEMINI.md + memport | AGENTS.md + rules | CONVENTIONS.md + `--read` |
| 子目录按需 | ✅ | 三级合并（全局/根/cwd） | ✅ | ✅ | ❌（显式 /add） |
| 自动记忆 | ✅ 默认开 | `memories` 配置 | 🔬 实验 | 未见 | ❌ |
| 用量显示 | `/context`+statusline | `/status` | 有 | `stats` | `/tokens` |
| 上下文注入方式 | 追加到首条 user message（非 system prompt），并明示"非强制" | AGENTS.md 启动合并 | — | — | 文件全文入 chat（显式、成本高） |

**差异要点**：
- **Codex 的 AGENTS.md 合并规则最清晰**（`~/.codex/AGENTS.md` → repo root → cwd，冲突时更近者优先），且有 `--no-project-doc` / `CODEX_DISABLE_PROJECT_DOC=1` / `[project_docs] enabled=false` 三种关闭方式。
- **Aider 走"显式文件集"路线**：必须把文件加入 chat（`/add`），靠 repo map（tree-sitter）补全局视野。优点是 token 可控、可预测；缺点是"忘记加文件"是新用户第一坑。
- **kcode 若要兼容生态，读 AGENTS.md 是最高性价比**（Codex/OpenCode/Goose/Qwen/Cursor 都吃它）。

---

## 5. 维度 4：工具面

### ■ 共有基线（工具面"缺一即残"）

1. 读文件 / 写文件 / 编辑文件（**编辑必须是 diff/patch 语义**，不是全文重写）。
2. 搜索：文件名 glob + 内容 grep（两者都要）。
3. Shell 执行：超时、输出截断、非交互子进程、可控工作目录。
4. Web 搜索 + URL 抓取（Claude WebFetch/WebSearch；Gemini `google_web_search`/`web_fetch`；Codex `webSearch` item；OpenCode `webfetch`/`websearch` 权限项）。
5. Todo/plan 结构（Claude task 工具、Codex `plan` item、Gemini todos 教程、Qwen todo-write 工具）。
6. 子代理/任务委派（Claude Task + subagents；Codex `/review` 起专用 sub-agent；OpenCode `task` 权限即子代理；Gemini/Qwen subagents）。
7. MCP 客户端（本地 stdio + 远程 HTTP/SSE）。
8. 每个工具都能被权限系统单独门控。

### ◆ 加分项

- **LSP / diagnostics 接入**：OpenCode 有独立 `lsp` 权限与 LSP Servers 文档 + formatters；Qwen 有 LSP 工具文档；Claude 走"code intelligence plugin"（装 language server 后"编辑后能看见类型错误、按符号导航"）；Codex/Gemini/Aider 未见内置 LSP。
- **后台任务与自定步节奏**：Claude `Monitor` 工具 + `--bg --exec`（PTY 后台作业）；Codex `turn/interrupt`。
- **浏览器**：Claude `--chrome`（Chrome 集成做 Web 自动化/测试）；Qwen browser use `[索引]`。
- **计算机使用**：Claude CLI 内 computer use（macOS，开/点/输入/看屏）；Qwen computer use；Goose `computercontroller` builtin。
- **交互式 shell/PTY**：Claude `--exec` 明确 "PTY-backed"。
- **多文件读与批量编辑**：Qwen 有 multi-file read 工具文档；Claude Edit 支持多文件串行；Codex `fileChange` item 支持 create/delete。
- **图像查看**：Codex `imageView` item（agent 主动看图）；Claude 多模态输入。
- **连接器/Apps**：Codex `/apps` 管理 ChatGPT app connectors（`[镜像]`）；Claude connectors/MCP 面板。
- **worktree 隔离**：Claude `-w/--worktree` + `--tmux`；Gemini git worktrees（🔬）；Qwen worktrees。
- **工具级参数匹配**：Claude `Bash(git log *)`、`mcp__*`；OpenCode bash 规则按"解析后的命令"匹配（`git status --porcelain`）。

### 差异表

| 工具 | Claude Code | Codex | Gemini | OpenCode | Aider |
|---|---|---|---|---|---|
| 编辑机制 | Edit 工具（精确替换）+ 权限弹窗 diff | `fileChange`/apply_patch 语义 | `write_file`/`replace`（整段替换） | `edit`/`write`/`patch` | **多种 edit format**（diff/whole/udiff）+ lint/test 自动回修 |
| 搜索 | Glob + Grep（macOS/Linux 默认集不含，可按需） | 内含 | 有 | `glob` `grep` 独立权限 | repo map + `/ls` |
| Shell 后台 | ✅ PTY 后台作业 | 沙箱内执行 | ✅ | ✅ | `/run` 前台 + `/test` |
| LSP | 插件式 | ❌ | ❌ | ✅ 原生 | ❌ |
| 子代理 | ✅ 可嵌套（子代理再起子代理） | ✅（review 专用） | ✅（含 remote subagents） | ✅ `task` | ❌ |
| 浏览器/计算机 | ✅ Chrome + computer use | ❌ | ❌ | ❌ | ❌ |
| 任务看板 | agent view / agent teams | ❌ | ❌ | ❌ | ❌ |

**结论**：工具面的分水岭是 **LSP 与"后台/并行执行"**。纯 shell+文件 已完全商品化；2026 年的差异在于"agent 能不能看见类型错误""能不能同时跑几件事"。

---

## 6. 维度 5：交互

### ■ 共有基线

1. 多行输入（`Shift+Enter` 需终端支持，退化为 `\<Enter>`、`{ }` 块、`/editor`）——Aider 文档直言"终端没有可移植的 Shift+Enter 检测"，这是所有实现共同的坑。
2. 历史回溯 + 反向搜索（`Ctrl+R`）。
3. 补全：slash 命令补全（Codex `Tab`）、`@` 文件补全（OpenCode）、路径补全。
4. 粘贴图片（OpenCode 拖拽；Aider `/paste`；Claude 粘贴）。
5. 审批档位（plan / 自动接受编辑 / 全放行）。
6. diff 预览（Claude 权限弹窗内联 diff + `/diff` 面板；Aider `/diff`）。
7. 工具调用可折叠、可中断（`Ctrl+C` 保留半截回复——Aider 明确说明）。
8. 主题（Gemini themes 文档；OpenCode themes；Claude 自定义主题可随插件发布）。
9. 状态栏（Claude `statusLine` 可配置显示 context/cost/git）。
10. 快捷键可配置（Claude `keybindings` 文件；OpenCode `keybinds`）。

### ◆ 加分项

- **vim 模式**：Claude（terminal-config 文档）、Aider `--vim`（完整 emacs/vi 键位表）。**这是高频诉求**，成本低。
- **参数级"持久允许"**：Claude `Bash(git log *)` 规则 + 会话内 always；OpenCode `once/always/reject`，`always` 会给出"将要放行的 pattern 集合"（如 `git status*`）；Codex 沙箱升级弹窗 `[a] once / [s] session / [p] policy / [d] decline`。**这三家都把"这次允许"和"以后都允许"分开了**，只做 y/n 的产品会被抱怨。
- **审批模式语义化**：Claude 六档 `default/acceptEdits/plan/auto/dontAsk/bypassPermissions`（`manual` 为 default 别名），`Shift+Tab` 循环；`auto` 是**分类器自动批准**，可用 `claude auto-mode defaults --label 'Git Destructive'` 查看内置规则、支持 hard deny。Codex 是 `approval policy`（never/on-request/unless-trusted/on-failure）× `sandbox mode` 的二维矩阵。
- **无障碍**：Claude `--ax-screen-reader` 扁平输出 + reduced motion + 色盲主题。
- **语音**：Claude 按住/点击录音听写；Aider `/voice`。
- **通知**：Claude 终端 bell + hooks；Gemini Notifications（🔬）；Aider notifications 文档；Codex `notification` 配置段。
- **全屏渲染**：Claude `tui` 设置 + fullscreen（鼠标支持、长会话内存稳定、无闪烁）。
- **prompt 建议**：Claude `--prompt-suggestions`（预测下一条用户输入）。
- **命令面板**：OpenCode 内置 palette（含"Enable auto-approve permissions"）；Claude 以 `/config` + mods 面板替代。

### 差异表

| 交互点 | Claude Code | Codex | Gemini | OpenCode | Aider |
|---|---|---|---|---|---|
| 审批档位 | 6 档（含 auto 分类器） | approval policy × sandbox 二维 | approval modes + 策略引擎 | allow/ask/deny + `--auto` | `--yes-always` |
| 持久允许粒度 | 参数级字符串匹配 | session/policy 两级 | TOML `commandPrefix` + priority | pattern（`git *`、URL、路径） | 无（全放行或逐次问） |
| vim | ✅ | 未文档化 | 未文档化 | 未文档化 | ✅ `--vim` |
| 状态栏 | ✅ 可配置 | `/status` | 有 | 有 | 无（打印 token/cost 行） |
| 语音 | ✅ | ❌ | ❌ | ❌ | ✅ |
| 计划模式 | `--permission-mode plan` + plan 审批 | `plan` item | Plan Mode（🔬 + model steering） | Tab 切 Build/Plan | `/architect`（双模型分工） |

---

## 7. 维度 6：扩展

### ■ 共有基线

1. **内置 slash 命令 + 自定义命令**（Claude `.claude/commands`/skills；Codex `/review /use /apps /model /approval /sandbox /status /clear /reset`；Gemini custom commands；OpenCode commands；Qwen commands）。
2. **MCP 配置落在文件**（项目级 + 用户级）。
3. **权限规则文件**（settings 里的 allow/deny）。
4. **settings 层级**（user/project/local + 环境变量 + CLI flag）。
5. **子代理定义文件**（Claude `.claude/agents`；OpenCode `.opencode/agent`；Gemini subagents；Qwen SubAgents）。
6. **生命周期钩子或等价物**（Claude hooks：PreToolUse/PostToolUse/SessionStart/PreCompact/InstructionsLoaded/Setup；Gemini hooks；Qwen hooks；OpenCode plugins 承担）。

### ◆ 加分项

- **Skills 已成事实标准**：Claude skills（含 `skillOverrides`、`disableBundledSkills`）、Codex `SKILL.md` + `$skill` 调用 + `/use`、Gemini Agent Skills、OpenCode Agent Skills、Qwen Skills、Goose skills（`goose skills list` 显示 token 数与来源）。
- **插件 + 市场**：Claude 有官方/社区/演示三个 marketplace、`claude plugin install x@marketplace`、从目录/`.zip`/URL 安装（`--plugin-dir`/`--plugin-url`）、**插件 eval 门禁 CI**（`claude plugin eval`）、插件可携带 skills/hooks/MCP/agents/命令/主题；OpenCode `plugin <module>`（npm 生态）；Goose `plugin install <git-url> --auto-update`（落到 `~/.agents/plugins/`）；Gemini extensions 有 registry 浏览页。
- **MCP OAuth 命令行化**：Claude `claude mcp login <name>`（HTTP/SSE/connector，`--no-browser` 走 SSH 粘贴回调）、`mcp logout`；OpenCode `mcp auth/list/logout/debug`；Codex 有 MCP OAuth 配置段 `[镜像]`；Goose 有 MCP elicitation / MCP roots / MCP Apps。
- **企业托管**：Claude `managed-settings.json`（含 `claudeMd`、`permissions.deny`、`sandbox.enabled`、`forceLoginMethod`）、`managed-mcp.json` + `--strict-mcp-config`、`--setting-sources`；Gemini enterprise 配置页；OpenCode enterprise 页。
- **UI 扩展（mods）**：Claude 允许插件画 pane、按钮、输入框、接管事件、调模型、定时器——CLI 里的"插件 UI"是 2026 新出现的层。
- **ACP 作为扩展出口**：OpenCode `acp` 子命令、Gemini ACP mode、Qwen ACP bridge、Cursor ACP、Goose ACP providers；Zed 侧有 ACP Registry 与 `agent_servers` 自定义配置 <https://zed.dev/docs/ai/external-agents>。

### 差异表

| 扩展面 | Claude Code | Codex | Gemini | OpenCode | Aider |
|---|---|---|---|---|---|
| 自定义 slash | ✅（skills 兼命令） | **文档明确"暂不支持自定义 slash"**，用 skills/AGENTS.md/alias 替代 | ✅ custom commands | ✅ commands | ✅（`/load` 脚本） |
| 插件市场 | **✅ 三个官方 marketplace** | ❌ | ✅ extensions（有 registry 站点） | ✅ npm plugin | ❌ |
| hooks 事件数 | 最全（含 InstructionsLoaded/Setup/PreCompact） | ❌ | ✅ | 通过 plugin | ❌ |
| MCP 管理 UX | `claude mcp` + `mcp login` + `/mcp` 面板 | config.toml + `/apps` | `gemini mcp` + `/mcp` | `mcp add/list/auth/debug` | ❌ |
| 配方/复用 | skills + plugins | skills | extensions + skills | skills + agents + commands | `/load` 命令脚本 |

**结论**：扩展面的"基线"已经上移到 **skills + MCP + hooks + 自定义命令 + settings 层级** 五项齐备；**插件市场是差异化**（Claude 明显领先），但"能从 git/npm 装插件"正在变成加分项的常规操作（Goose/OpenCode）。

---

## 8. 维度 7：模型与成本

### ■ 共有基线

1. 多 provider + BYOK（Aider 支持 OpenAI/Anthropic/Gemini/GROQ/xAI/Azure/Cohere/DeepSeek/Ollama/OpenRouter/Copilot/Vertex/Bedrock/OpenAI-compatible）。
2. 两种登录：订阅 OAuth 与 API key（Claude `auth login` 支持 `--console`/`--sso`，`authMethod` 枚举含 `claude.ai/oauth_token/api_key/api_key_helper/third_party`；Codex ChatGPT 登录或 key；Gemini Google 登录/Vertex/key；OpenCode `auth login` 按 provider + Zen）。
3. 会话内模型切换（`/model`、`--model`、OpenCode `models` 列 `provider/model`）。
4. 模型别名（Claude `sonnet/opus/haiku/fable`；Aider `--model sonnet`）。
5. 用量统计（Claude `/usage`（按 skills/subagents/MCP 归因）、OpenCode `stats --days --models --tools --project`、Aider 每轮打印 tokens/cost）。

### ◆ 加分项

- **fallback 链**：Claude `--fallback-model sonnet,haiku`（可持久化为 `fallbackModel` 设置）；Gemini model routing（自动 fallback，<https://geminicli.com/docs/cli/model-routing/>）。
- **预算硬闸**：Claude `--max-budget-usd`（子代理计入，超限后禁止再起子代理）。
- **思考/effort 档位**：Claude `--effort low|medium|high|xhigh|max|ultracode`；OpenCode `--variant` + `--thinking`；Codex `model_reasoning_effort`；Aider `/reasoning-effort`、`/think-tokens`。
- **双模型分工**：Aider 主/弱/编辑三模型 + `/architect`（architect 规划 + editor 落地）；Claude `--advisor`（关键时刻咨询更强模型）；Codex `review_model`。
- **模型目录与元数据**：OpenCode 基于 models.dev，`models --refresh --verbose`（含成本元数据）。
- **缓存可视化**：Claude 有 prompt-caching 专页（解释 `/compact` 成本、缓存命中率查询）；Gemini token caching；Qwen token caching。
- **本地推理**：Goose `local-models search/download/list/delete`（HuggingFace GGUF/MLX）；Aider Ollama/LM Studio。
- **企业网关/三方云**：Claude `claude gateway --config gateway.yaml`（SSO + 策略前置）+ Bedrock/Vertex/Foundry；Codex custom providers。

### 差异表

| 能力 | Claude Code | Codex | Gemini | OpenCode | Aider |
|---|---|---|---|---|---|
| fallback | ✅ 链式 + 设置项 | 未见 | ✅ routing | 未见 | 手动 `/model` |
| 预算上限 | ✅ USD | 未文档化 | 配额（订阅侧） | 未见 | ❌ |
| 成本归因 | ✅ 按 skill/subagent/MCP | 未见 | 未见 | `stats` | 每轮打印 |
| 提示缓存说明 | ✅ 专页 | 未见 | token caching | 未见 | `/docs/usage/caching` |

---

## 9. 维度 8：安全与治理

### ■ 共有基线

1. 工具级 allow/deny + 每次执行审批。
2. 项目信任（Claude workspace trust / Gemini trusted folders / Qwen trusted folders / Zed worktree trust）。
3. 危险命令拦截（`rm -rf`、`git push` 类）。
4. 遥测开关（Claude env vars；Codex analytics/feedback 配置；Gemini telemetry；Goose usage data；Aider `--analytics`）。

### ◆ 加分项（这一维度是"企业能不能买"的门槛）

- **OS 级沙箱，且分平台实现**：Codex 最完整——Linux **Landlock + seccomp**（内核 5.13+/5.19+ 全支持）或实验性 **bubblewrap**（namespace + 只读 root + bind mount + 托管网络代理）；macOS **Seatbelt**（`sandbox-exec` 动态生成 profile）；Windows **restricted tokens + job objects**（elevated/unelevated 两种模式）。<https://mintlify.wiki/openai/codex/concepts/sandboxing.md>
- **保护路径**：Codex 在 `workspace-write` 下 `.git/`、`.codex/`、`gitdir:` 符号链接始终只读且递归生效；可追加 `protected_paths = [".env","secrets/"]`。
- **网络策略与文件系统策略解耦**：`sandbox_policy.network_access = enabled|restricted`；bwrap 下用 `--unshare-net` + 代理 + seccomp 禁新建 socket。
- **沙箱内升级审批**：Codex 三级 `[a] once / [s] session / [p] policy`；Claude 有 `sandboxed Bash` 工具 + network allowlist 与 auto mode 的 hard deny。
- **策略引擎（可版本化、可分优先级）**：Gemini `~/.gemini/policies/*.toml`，`[[rule]] toolName/commandPrefix/decision/priority`，支持 MCP 工具与子代理特化语法，Windows 也有 PowerShell 目录创建示例。<https://geminicli.com/docs/reference/policy-engine/>
- **企业托管配置**：Claude managed settings（可强制 `sandbox.enabled`、`forceLoginMethod`、`forceLoginOrgUUID`、`permissions.deny`、托管 CLAUDE.md）+ `managed-mcp.json` 独占模式；Gemini enterprise；OpenCode enterprise。
- **受限/评测模式**：Claude `--restricted`（不给命令执行工具、不给 WebFetch、文件工具限制在工作目录、只读 managed settings、拒绝 bypass）。
- **本地数据治理**：Claude `claude purge [path] --dry-run|-y|--all` 清理 transcript/任务列表/调试日志/文件编辑历史/prompt 历史；`cleanupPeriodDays` 保留策略且**记忆文件不被清理**。
- **可观测性/审计**：Claude Agent SDK OpenTelemetry（traces/metrics/events）+ 自托管 runner 的 Prometheus metrics；Gemini telemetry；Goose logs + diagnostics。
- **防呆**：OpenCode `doom_loop` 权限（同一工具同参数连续 3 次即触发 ask）；Goose `--max-tool-repetitions`；Codex `turn/interrupt`。
- **容器化执行**：Goose `--container <id>`（扩展跑在 Docker 内）；Claude sandbox environments（devcontainer/Docker/VM 选型文档）；Gemini sandbox（seatbelt/docker/podman）。

### 差异表

| 安全能力 | Claude Code | Codex | Gemini | OpenCode | Aider |
|---|---|---|---|---|---|
| 默认沙箱 | 可选（sandboxed bash） | **默认开** | 可选 | ❌ | ❌ |
| Windows 沙箱 | 依赖宿主（未见 OS 级） | **restricted token + job object** | 未见 | ❌ | ❌ |
| 网络白名单 | ✅ sandbox network hosts | ✅ network_access + 代理 | 沙箱内 | ❌ | ❌ |
| 策略文件 | settings.json 规则 + managed | config.toml policy | **TOML 策略引擎 + priority** | JSON permission 对象 | `--yes-always` |
| 审计/遥测 | OTel + Prometheus | tracing + analytics | telemetry 页 | 未见 | analytics |

**给 kcode 的直白结论**：Windows 优先的产品里，**只有 Codex 给了 Windows 原生沙箱方案（restricted token + job object）**。这是 Windows 上最难补、也最能形成差异的一块。

---

## 10. 维度 9：工程化

### ■ 共有基线

1. 一键安装：`npm i -g`（Gemini/OpenCode/Codex）、`curl | bash`（OpenCode/Cursor/Codex）、brew、scoop/choco（OpenCode 明确给 Windows 渠道）。
2. 自更新：`claude update`/`claude install stable|latest`、`opencode upgrade`、`goose update [--canary]`、`gemini` 升级路径。
3. 诊断命令：`claude doctor`（只读安装/设置校验）、`goose info -v`、`codex debug landlock`。
4. 跨平台：macOS/Linux/Windows；**Windows 质量是分水岭**（见 §12）。
5. changelog 稳定可追：Claude `/changelog` + 每周 "What's new"、Gemini stable/preview changelog、OpenCode v2 迁移说明。

### ◆ 加分项

- **原生二进制替换 JS 打包**：Claude 2026-w16 起 native binaries；Codex/Goose Rust；OpenCode 单二进制。
- **性能工程**：Claude `--bare` 快启动 + fast mode + fullscreen 渲染内存稳定；OpenCode `attach` 复用已启动 server 规避 MCP 冷启动。
- **评测可复现**：Aider 有公开 leaderboard（code editing / refactoring / by release date + benchmark notes），是少数把"评测方法"当文档发布的产品；Gemini 有 behavioral evals + integration testing 文档；Claude 有 `claude plugin eval`（插件级 eval，可 CI 门禁）。
- **公开基准**：CLI 形态更贴近 **Terminal-Bench**（<https://www.tbench.ai/>）而非 SWE-bench；SWE-bench 官方 leaderboard 在 <https://www.swebench.com/>。**注意：多数 CLI 产品不在官方文档里公布自己的基准分数**，厂商分数多出现在博客/第三方榜单，交叉验证成本高。
- **离线能力**：Goose offline docs；本地模型支持。
- **发行定制**：Goose `custom distributions`（企业改品牌/预置 extensions）。
- **可观测性**：见 §9。

---

## 11. 基线能力 Checklist（46 项，可勾选）

> 级别：**刚需** = 2026 年 CLI agent 没有就会被认为"不完整"；**加分** = 形成选型差异。
> 参照实现列给出"最值得抄的那家"。

### A. 入口与脚本化（8）

| ☐ | 能力 | 级别 | 参照实现 |
|---|---|---|---|
| ☐ | A1 TUI 默认入口 + 位置参数一次性 prompt | 刚需 | 全部 |
| ☐ | A2 无头打印模式（`-p`/`exec`/`run`） | 刚需 | Claude `-p` / Codex `exec` |
| ☐ | A3 stdin 管道输入 | 刚需 | Claude / Codex `-` |
| ☐ | A4 JSONL 事件流输出 | 刚需 | Codex `--json` |
| ☐ | A5 语义化退出码（含认证/配置/超限区分） | 刚需 | Codex 0/1/2/3/4/130 |
| ☐ | A6 无头模式可续跑会话 | 刚需 | Claude `-c -p` |
| ☐ | A7 JSON Schema 约束最终输出 | 加分 | Claude `--json-schema` / Codex `--output-schema` |
| ☐ | A8 轮次/预算闸门 | 加分 | Claude `--max-turns/--max-budget-usd` |

### B. 会话（7）

| ☐ | 能力 | 级别 | 参照实现 |
|---|---|---|---|
| ☐ | B1 `--continue` 续最近会话 | 刚需 | 全部 |
| ☐ | B2 按 ID/名称恢复 + 交互选择器 | 刚需 | Claude `-r` |
| ☐ | B3 会话命名/重命名 | 刚需 | Claude `-n` `/rename` |
| ☐ | B4 transcript 落盘且路径文档化 | 刚需 | Claude `.jsonl` / Codex rollout |
| ☐ | B5 fork / 分支会话 | 加分 | Claude `--fork-session` |
| ☐ | B6 checkpoint + rewind（文件+对话） | 刚需 | Gemini 影子 git `/restore`；Claude `/rewind` |
| ☐ | B7 导出/导入会话（含脱敏） | 加分 | OpenCode `export --sanitize` |

### C. 上下文与记忆（7）

| ☐ | 能力 | 级别 | 参照实现 |
|---|---|---|---|
| ☐ | C1 项目指令文件（AGENTS.md 兼容优先） | 刚需 | Codex 三级合并 |
| ☐ | C2 全局/项目/子目录分层 + 子目录按需加载 | 刚需 | Claude |
| ☐ | C3 `@` 文件引用与模糊搜索 | 刚需 | OpenCode `@` fuzzy |
| ☐ | C4 上下文用量可视化 | 刚需 | Claude `/context` |
| ☐ | C5 手动 + 自动压缩 | 刚需 | Claude `/compact` |
| ☐ | C6 自动记忆（跨会话，可查可改可关） | 加分 | Claude auto memory |
| ☐ | C7 路径作用域规则（`paths:` frontmatter） | 加分 | Claude `.claude/rules` |

### D. 工具面（9）

| ☐ | 能力 | 级别 | 参照实现 |
|---|---|---|---|
| ☐ | D1 读/写/编辑（diff 语义） | 刚需 | 全部 |
| ☐ | D2 glob + grep 双搜索 | 刚需 | Claude |
| ☐ | D3 shell 执行（超时/截断/工作目录） | 刚需 | 全部 |
| ☐ | D4 web 搜索 + 抓取 | 刚需 | Gemini `google_web_search` |
| ☐ | D5 todo/plan 结构 | 刚需 | Claude task tools |
| ☐ | D6 子代理委派 | 刚需 | Claude subagents |
| ☐ | D7 MCP 客户端（stdio + HTTP/SSE） | 刚需 | 全部 |
| ☐ | D8 LSP/diagnostics 接入 | 加分 | OpenCode LSP |
| ☐ | D9 后台任务 / 并行执行 | 加分 | Claude Monitor + `--bg --exec` |

### E. 交互（8）

| ☐ | 能力 | 级别 | 参照实现 |
|---|---|---|---|
| ☐ | E1 多行输入 + 外部编辑器（`Ctrl-X Ctrl-E`） | 刚需 | Aider |
| ☐ | E2 `Ctrl+R` 历史反向搜索 | 刚需 | Aider / Claude |
| ☐ | E3 slash + `@` 补全 | 刚需 | OpenCode |
| ☐ | E4 粘贴/拖拽图片 | 刚需 | OpenCode |
| ☐ | E5 审批模式（plan / 自动接受 / bypass） | 刚需 | Claude 6 档；Codex 二维矩阵 |
| ☐ | E6 参数级持久允许（once / session / policy） | 刚需 | Codex `[a]/[s]/[p]` |
| ☐ | E7 diff 预览 | 刚需 | Claude 内联 diff |
| ☐ | E8 vim 模式 / 可配置键位 | 加分 | Aider `--vim`；Claude keybindings |

### F. 扩展（6）

| ☐ | 能力 | 级别 | 参照实现 |
|---|---|---|---|
| ☐ | F1 自定义 slash 命令 | 刚需 | Claude / OpenCode |
| ☐ | F2 skills（按需加载的流程包） | 刚需 | Claude / Codex `SKILL.md` |
| ☐ | F3 hooks（PreToolUse/PostToolUse/SessionStart…） | 刚需 | Claude hooks |
| ☐ | F4 MCP 配置分层 + OAuth 登录命令 | 刚需 | Claude `mcp login` |
| ☐ | F5 settings 层级（user/project/local/flag/env） | 刚需 | Claude |
| ☐ | F6 plugins + marketplace | 加分 | Claude 三 marketplace；Goose git plugin |

### G. 模型与成本（5）

| ☐ | 能力 | 级别 | 参照实现 |
|---|---|---|---|
| ☐ | G1 多 provider + BYOK | 刚需 | Aider（最广） |
| ☐ | G2 OAuth 与 API key 双登录 | 刚需 | Claude / Codex |
| ☐ | G3 会话内模型切换 + 别名 | 刚需 | Claude `/model` |
| ☐ | G4 token/费用统计与归因 | 刚需 | Claude `/usage` |
| ☐ | G5 fallback 链 + 预算上限 | 加分 | Claude |

### H. 安全与治理（6）

| ☐ | 能力 | 级别 | 参照实现 |
|---|---|---|---|
| ☐ | H1 工具级 allow/deny + 每命令审批 | 刚需 | 全部 |
| ☐ | H2 项目信任/首次进入确认 | 刚需 | Claude workspace trust |
| ☐ | H3 危险命令拦截 | 刚需 | Claude auto-mode hard deny |
| ☐ | H4 OS 级沙箱（含 Windows 实现） | 加分 | Codex（Landlock/Seatbelt/job object） |
| ☐ | H5 网络白名单/策略 | 加分 | Claude / Codex |
| ☐ | H6 策略文件 + 企业托管配置 | 加分 | Gemini TOML 策略引擎；Claude managed settings |

### I. 工程化（4）

| ☐ | 能力 | 级别 | 参照实现 |
|---|---|---|---|
| ☐ | I1 一键安装 + 自更新 | 刚需 | Claude `install/update` |
| ☐ | I2 `doctor`/`info` 诊断 | 刚需 | Claude `doctor`；Goose `info -v` |
| ☐ | I3 Windows 原生可用（非必须 WSL） | 刚需 | Claude（无需 Git Bash）；Codex（原生沙箱） |
| ☐ | I4 公开评测或可复现 eval | 加分 | Aider leaderboard；Claude plugin eval |

**统计**：刚需 32 项，加分 14 项。若 kcode 目标客户是"中国开发者 + Windows"，则 E6、B6、H2、I3 的实际权重应再上调一档——这四项直接决定"敢不敢让它跑在自己机器上"。

---

## 12. Windows 优先专项（kcode 的直接机会）

以下是各产品在 Windows 上的真实状态，逐条都有文档依据：

| 主题 | 事实 | 来源 |
|---|---|---|
| 不再依赖 Git Bash | Claude Code 2026-w18 起 "on Windows runs without Git Bash" | <https://code.claude.com/docs/en/whats-new/2026-w18> |
| Windows 原生沙箱 | Codex 用 restricted tokens + job objects，支持 elevated/unelevated，经 app-server `windowsSandbox/setupStart` 配置 | <https://mintlify.wiki/openai/codex/concepts/sandboxing.md> |
| PowerShell 工具 | Claude 2026-w13 引入 "a PowerShell tool for Windows" | <https://code.claude.com/docs/en/whats-new/2026-w13> |
| 安装渠道 | OpenCode 给 choco/scoop/mise/WSL，且明说 "Windows 建议用 WSL 以获得更好性能与完整兼容" | <https://opencode.ai/docs/> |
| 符号链接坑 | Claude 文档明确：Windows 下建 symlink 需管理员或开发者模式，且 Git 默认把 symlink 检出为文本文件，因此**建议用 `@AGENTS.md` import 而非 symlink** | <https://code.claude.com/docs/en/memory> |
| 路径限制 | Claude `--add-dir` 不接受多数网络路径（`\\server\share`）；`.claude/rules` 指向 UNC/`/net` 的符号链接不加载 | <https://code.claude.com/docs/en/cli-reference>、memory 页 |
| 终端按键 | Aider 明说终端无法可移植检测 `Shift+Enter` | <https://aider.chat/docs/usage/commands.html> |
| 策略目录 | Gemini 策略引擎给 PowerShell 版目录创建命令（`$env:USERPROFILE\.gemini\policies`） | <https://geminicli.com/docs/reference/policy-engine/> |

**kcode 可打的四张牌**：
1. **ConPTY/PTY 稳定的后台任务与交互式 shell**（Windows 上最容易翻车、也最容易被感知）。
2. **restricted token + job object 沙箱**（照抄 Codex 的思路，做成本地默认而非可选）。
3. **不依赖 Git Bash / WSL 的原生体验**（Claude 已验证可行）。
4. **PowerShell 一等公民**：命令解析、危险命令拦截、权限 pattern 都要按 PowerShell 语法（包括 `;`、`|`、`&&`、别名 `ri/rm/del`）建模，而不是套 POSIX 规则。

---

## 13. 对 kcode 的落地优先级建议

| 优先级 | 内容 | 理由 | 参照 |
|---|---|---|---|
| **P0（不做就没法用）** | 无头 `-p` + `--json` 事件流 + 语义退出码；`--continue/--resume`；AGENTS.md 三级；diff 语义编辑；shell 超时/截断；每工具权限 + plan/auto-accept/bypass；`Ctrl+R` 与多行输入；安装/自更新/doctor | 32 项刚需里去掉这些，"脚本化 + 日常编码"两条主链路都断 | A4/A5/A6、B1/B2、C1、D1-D3、E2/E5、H1、I1/I2 |
| **P1（决定留存）** | checkpoint/rewind；参数级"once/session/always"；`@` 模糊引用 + 上下文用量；MCP + OAuth 登录；skills + 自定义 slash；成本统计与 fallback | 用户在被改坏一次文件、或第 20 次点 y 之后就会换工具 | B6、E6、C3/C4、F2/F4、G4/G5 |
| **P2（做差异化）** | Windows 沙箱（token+job object）+ 网络白名单；子代理 + 后台任务；LSP/diagnostics；vim 模式；语音；hooks 事件面；插件/市场 | 前两项是"企业能采购"的门槛，后几项是口碑 | H4/H5、D6/D9、D8、E8 |
| **P3（观察）** | ACP 服务端（`kcode acp`）；常驻 `serve` + SDK；策略文件（TOML/JSON + priority）；评测体系（Terminal-Bench 子集 + 自建 eval） | ACP/SDK 让 kcode 能被 Zed/其他编辑器当外部 agent 调用，成本低于自建 IDE 插件 | <https://agentclientprotocol.com>、<https://www.tbench.ai/> |

---

## 14. 置信度与未验证项（避免过度断言）

| 项 | 状态 |
|---|---|
| Cursor CLI 的 JSON/JSONL 输出与退出码 | **未验证**。官方 overview 只展示 `-p ... --output-format text`，headless/CI 页存在但未读正文 <https://cursor.com/docs/cli/headless> |
| Codex 文档时效 | `[镜像]` 页面标注 generated 2026-02-28；官方 `developers.openai.com/codex/*` 对本环境 403。2026-10 后的新增能力可能未覆盖 |
| Gemini CLI 的 LSP / 会话命名 / 导出 | 文档导航未见独立页面，按"未见"处理而非"确定没有" |
| Qwen Code 具体行为 | 仅读文档导航 `[索引]`（headless/approval/sandbox/LSP/computer use/goals/channels 等页面存在），细节未逐页核对 |
| Codex "自定义 slash command" | 镜像页明确写"不支持"；但 Codex 同期已有 skills 与 prompts 机制，结论仅适用于 slash 命令这一形态 |
| 基准分数 | 未在任何官方文档中读到具体 SWE-bench / Terminal-Bench 数值；引用的只有榜单站点本身 |
| Aider MCP 支持 | 未在官方文档导航中见到 MCP 页面，按"无"处理 |

---

## 15. 一句话总结

2026 年成熟 CLI 编码 agent 的基线已经**不是"能改文件 + 能跑命令"**，而是五件套：
**① 机器可读的无头契约（JSONL + 退出码 + schema）② 可回滚的会话与文件状态 ③ 分层且可自动积累的上下文 ④ 参数级的权限自治（once/session/policy）⑤ OS 级隔离（Windows 也要有）**。
Claude Code 在 ③④⑤ 的"产品完成度"上领先，Codex 在 ①②⑤ 的"工程严格度"上领先，Gemini CLI 的策略引擎与影子 git 是两份被低估的设计，OpenCode 的 client/server 架构和 Aider 的显式文件集是两种相反的取舍，Goose 的 recipes/schedules 是最接近"CI 里的 agent"的形态。
kcode 在 Windows 上把 ⑤ 做成本地默认，是最短路径的差异化。

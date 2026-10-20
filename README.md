# kcode（快码）

[![ci](https://github.com/w13136199130/kcode/actions/workflows/ci.yml/badge.svg)](https://github.com/w13136199130/kcode/actions/workflows/ci.yml)

> **本地优先的 AI 编程 Agent** —— 数据留在你的机器上，模型由你选择。
> **A local-first AI coding agent** — your data stays on your machine, and the model is your choice.

TypeScript 全栈实现对标 Claude Code/ZCode 形态：单进程内嵌引擎（会话落 JSONL、--resume 续接）、Agent 循环、权限沙箱、BYOK 多厂商模型接入、Ink 终端界面、技能与项目记忆、可回放会话，以及插件市场的完整规划。
A TypeScript implementation targeting Claude Code/ZCode-class capability: a single-process embedded engine (JSONL sessions, --resume), an agent loop, a permission sandbox, BYOK multi-vendor model access, an Ink TUI, skills & project memory, replayable sessions — with a full plugin-marketplace roadmap.

---

## 亮点 | Highlights

- 🔒 **key 永不上云** · **Keys never leave your machine** —— 受众绑定（key 只能发往 keychain 登记的端点，篡改即硬失败）+ AES-256-GCM 加密存储 / Audience-bound keys (a key can only be sent to endpoints registered in the keychain) with AES-256-GCM encrypted storage.
- 🛡️ **权限引擎** · **Permission engine** —— 读放行、写与命令逐次菜单确认（y/s/p/n）、未知工具拒绝；放行可记**会话级**或**项目级持久**（落盘 `~/.kcode/permissions.json`，`/permissions` 查看/清除）；`/plan` 一键进入只读计划模式（持久放行不穿透只读档）/ Reads allowed, writes & commands confirmed per-call (y/s/p/n); grants persist per-session or **per-project** (`~/.kcode/permissions.json`, inspect via `/permissions`); `/plan` toggles a read-only mode that persistent grants cannot pierce.
- 🧩 **渐进式技能与记忆** · **Progressive skills & memory** —— SKILL.md 仅元数据常驻上下文，命中触发词才加载正文；AGENTS.md 项目记忆进稳定区 / SKILL.md metadata stays in context, the body loads only on trigger; AGENTS.md project memory in the stable zone.
- 📼 **可回放会话** · **Replayable sessions** —— JSONL append-only 事件流，回放一致性进 CI，天然作为 eval 夹具 / Append-only JSONL event stream with replay-consistency checks in CI — a natural source of eval fixtures.
- 🧪 **双模式验收** · **Dual-mode acceptance** —— scripted 框架自检进 CI；真实模型 10 任务评分（GLM-5.3 实测 **10/10** 通过）/ Scripted self-check in CI plus a 10-task real-model suite (10/10 with GLM-5.3).
- ♻️ **瞬态失败自动重试** · **Automatic transient retries** —— 429/网关/网络抖动指数退避重放（清洁重试：仅未出内容时重试，Retry-After 优先）/ Exponential-backoff replays for 429/gateway/network glitches (clean-retry only, honors Retry-After).
- 🖥️ **Ink TUI** —— 流式输出、Markdown 渲染 + 代码高亮（marked + highlight.js）、工具状态行、Todo 面板、结构化选择题、后台任务通知 / Streaming output, Markdown rendering with syntax highlighting, tool status rows, a todo panel, structured questions, background-task notices.

## 路线图进度 | Roadmap Status

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 地基 | monorepo / contracts / 会话回放 / CI 门禁 | ✅ |
| P1 单机 CLI | 工具链（rg/bash/write/edit）、providers、权限 v1、TUI、Plan/Todo/ask_user/图片 | ✅ 真实模型验收 10/10 |
| P2 上下文工程 | SKILL.md 渐进加载 ✅ · AGENTS.md 记忆 ✅ · resume ✅ · 摘要压缩 ✅（分窗压缩/真 tokenizer 见 B3） | ✅ 主体完成 |
| P3 扩展 | MCP（stdio）✅ / hooks ✅ / 斜杠命令 ✅ / 插件装卸+沙箱 v1 ✅ / epoch E2E 加密层（P4-1 提前）✅ | ✅ |
| A 级体验轮 | bash cd 持久 · 项目级放行+`/permissions` · `/cost` 用量 · LLM 重试退避 · `/resume`+多行输入 · Markdown 渲染+代码高亮 | ✅ 2026-09 |
| B 级 Agent 能力核 | 子代理（`.kcode/agents` + task 工具）· 计划双闸门+`/rewind` 检查点 · 上下文三层压缩 · 交互补齐（Shift+Tab/@引用/!bash）· 稳固性（MCP 超时/原生 keychain） | 🚧 设计定稿，[DESIGN.md](./DESIGN.md) |
| C 级单进程化 | 引擎抽入 `@kcode/session` · CLI 内嵌组装 · 会话 JSONL+`--resume` 不变 · **daemon 已剔除** | ✅ 2026-09，[DESIGN.md](./DESIGN.md) |
| P4 账户 / 云 / 市场 | IdP / relay E2E / registry + Sigstore | ⏳ |
| P5–P6 | 自动化调度 / 电脑控制 | ⏳ |

完整设计（13 条 ADR、目录树、安全模型、企业就绪清单）见 [DESIGN.md](./DESIGN.md)。
Full design (13 ADRs, directory tree, security model, enterprise-readiness checklist) in [DESIGN.md](./DESIGN.md).

---

## 快速开始 | Quick Start

**前置 | Prerequisites**：Node.js ≥ 22 · pnpm ≥ 10 · Windows 需 Windows Terminal（§6）/ On Windows use Windows Terminal.

**1. 安装 | Install**

两种方式 | Two ways:

- **发行包（免源码免依赖，只需 Node ≥22） | Release tarball**——先在仓库内 `pnpm release` 出产物（`apps/cli/dist/release/` 的 tar.gz + sha256 + latest.json），然后分发安装：

```bash
# POSIX：装到 ~/.kcode/bin（sha256 校验；参数为 tar.gz 的本地路径或 URL，可附 latest.json）
sh deploy/install.sh kcode-0.1.0-win32-x64.tar.gz latest.json
# Windows PowerShell
.\deploy\install.ps1 -Source kcode-0.1.0-win32-x64.tar.gz -Meta latest.json
# 或手动：解包后 node kcode.mjs "你的问题"
```

- **源码运行 | From source**：

```bash
git clone https://github.com/w13136199130/kcode.git
cd kcode && pnpm install
```

> 构建发行包：`pnpm release`（tsup 全量打包 → tar.gz + sha256 + latest.json；rg 二进制为构建机平台，跨平台需在目标平台构建）。

**2. 配置模型 | Configure a model** —— 写用户级配置 `~/.kcode/config.json`（`providers` 只允许在这一层，项目级配置无此字段——防 key 外泄的第一层防御 §5.7）：
Write `~/.kcode/config.json` (the user-level config is the only place `providers` may live — the first layer of key-exfiltration defense):

```jsonc
{
  "models": {
    "default": "glm/glm-5.3",
    "providers": {
      "glm": {
        "type": "openai-compatible",
        "baseURL": "https://open.bigmodel.cn/api/paas/v4",
        "keyRef": "keychain://glm"
      },
      "ollama": { "type": "openai-compatible", "baseURL": "http://127.0.0.1:11434/v1" }
    }
  }
}
```

任何 OpenAI 兼容端点（DeepSeek / GLM / one-api 中转 / Ollama / vLLM）均可；本地 Ollama 无需 key。
Any OpenAI-compatible endpoint works (DeepSeek / GLM / one-api / Ollama / vLLM); local Ollama needs no key.

**3. 录入 key | Record the key**（受众绑定：key 只发往登记端点 §5.7；Ollama 跳过 / skipped for Ollama）：

```bash
pnpm --filter @kcode/cli start key add keychain://glm sk-你的key https://open.bigmodel.cn/api/paas/v4
pnpm --filter @kcode/cli start key list
```

需先设口令环境变量（加密本地 keychain 用）· Set the passphrase env var first (it encrypts the local keychain). **三种终端语法对照 | shell syntax cheat sheet**：

| 终端 Shell | 写法 Syntax |
|---|---|
| PowerShell | `$env:KCODE_KEYCHAIN_PASSPHRASE="你的口令"` |
| cmd | `set KCODE_KEYCHAIN_PASSPHRASE=你的口令` |
| Git Bash / macOS / Linux | `export KCODE_KEYCHAIN_PASSPHRASE="你的口令"` |

**4. 开始使用 | Run**

```bash
pnpm --filter @kcode/cli start                            # REPL（TUI）
pnpm --filter @kcode/cli start "受众绑定校验在哪实现？"      # 一次性提问 one-shot
pnpm --filter @kcode/cli start --image ./pic.png "图里是什么？"   # 多模态附图
pnpm --filter @kcode/cli start --resume latest             # 续接最近会话（分支）
pnpm --filter @kcode/cli start --resume sess_xxx "接着说"   # 指定会话续接
```

REPL 内：`/plan` 切换计划模式（模型只读研究 → 调用 plan_submit 提交计划 → **菜单批准后自动切回执行**，批准的计划成为压缩锚点）；`/rewind` 回退到之前任意一轮提问（文件快照 + 对话一起回滚，空闲双击 Esc 直达）；`/diff [文件]` 审查本会话的文件改动（changed files + hunks，不必切 git），在面板内按 `r` 二次确认后逐文件回退到本会话前（复用检查点前像）；`/compact` 手动压缩、`/context` 查看 token 占用（上下文三层治理：工具结果 micro 截断 → 超预算 60% 自动压缩【预算按模型窗口派生】→ 手动；已批准计划跨压缩保真）；`/cost` 查看本会话 token 用量（缓存命中/写入、推理 token、按模型与工具分项、子代理分项；厂商未回报时降级显示）；`/audit [N]` 查看工具裁决审计（独立 JSONL：`~/.kcode/cli/audit/<sessionId>.jsonl`，含工具/裁决/scope/耗时/cwd/权限档）；`/resume [latest|id]` 不重启续接历史会话；`/clear` 清屏开新会话、`/status` 状态一览；`# 内容` 或 `/remember 内容` 写入项目 AGENTS.md（下次会话生效，`#include` 等非 `# ` 开头按普通提问发送）；**Shift+Tab** 循环权限模式、**@** 补全文件路径、**!命令** 直执行 shell（`/Users/...` 等斜杠路径按普通提问发送，未知 `/命令` 保留原文）；**Ctrl+G** 外部编辑器、**Ctrl+A/E/U/K/W** 行编辑、**Alt/Ctrl+←→** 按词移动、**Ctrl+B** 工具浏览器（长输出分页/`/` 搜索/`c` 复制，失败默认末尾，给出 JSONL 路径）、**Ctrl+O** 展开/折叠思考与工具输出（清屏重放，已滚出的块也能展开）、**Ctrl+T** 后台任务面板（`s` 停止运行中任务）；状态栏 `⚙ N` 显示运行中后台任务，完成时响铃；`/tasks` 列清单、`/tasks stop <id>` 终止；多行输入用 **Ctrl+J** 换行；输入历史跨启动持久化；`exit` 退出。
In the REPL: `/plan` toggles plan mode (read-only research → plan_submit → **approve to switch back and execute**); `/rewind` rolls code and conversation back to any earlier prompt (double-Esc when idle); `/diff [file]` reviews this session's changed files and hunks in-TUI, with per-file revert from checkpoints (confirmed); `/cost` shows token usage with cache hit/write, reasoning tokens, per-model/tool breakdown and subagent usage (graceful fallback when the provider reports no details); `/audit [N]` shows tool-decision audit records from the per-session JSONL (`~/.kcode/cli/audit/<sessionId>.jsonl`); `/resume [latest|id]` continues a past session; `# note` or `/remember note` appends to the project AGENTS.md (loaded next session); **Ctrl+G** opens `$EDITOR`, **Ctrl+A/E/U/K/W** edit lines/words, **Alt/Ctrl+←→** move by word, **Ctrl+B** browses tool output (paging, `/` search, `c` copy, failed output starts at the tail, JSONL path shown), **Ctrl+O** expands/collapses thoughts and tool output with a screen replay, **Ctrl+T** lists background tasks (`s` stops the selected running task); the status bar shows `⚙ N` and a bell rings when a background task finishes; `/tasks` lists them and `/tasks stop <id>` terminates; press **Ctrl+J** for a newline; `exit` quits.
In the REPL: `/plan` toggles plan mode (read-only research → switch back after approval); `exit` to quit.

**终端兼容与安全 | Terminal safety**：不可信文本（模型回复/工具输出/粘贴内容/文件名/审批命令）渲染前剥离 ESC/OSC/CSI 控制序列，恶意内容不能改窗口标题或写剪贴板；自家 OSC8 文件链接在剥离后重新生成。`NO_COLOR=1` 关闭颜色；`KCODE_PLAIN=1` 关闭颜色并把状态符换成 ASCII（CI/日志友好）；`KCODE_THEME=light` 切亮色主题（白底可读）；`KCODE_LINKS=0/1` 强制关/开文件链接。

**试试技能自动触发 | Try skill auto-trigger** —— 建一个**用户级**技能目录（`~/.kcode/skills/<name>/SKILL.md`；项目/插件技能默认手动，需 `/skill <name>` 显式加载）：
Create a user-level skill directory and mention a trigger word in your prompt:

```text
~/.kcode/skills/code-review/SKILL.md
---
name: code-review
description: 审查当前变更的代码质量
triggers:
  - 审查
  - code review
---
（技能正文：审查步骤与输出格式……）
```

输入任何包含"审查"的话，技能正文会自动注入本轮上下文（界面显示 📖 已加载）。
Any prompt containing a trigger word auto-loads the skill body into the turn (shown as 📖 loaded).

3-18 起：`disable-model-invocation: true` 强制仅手动，`allowed-tools` 解析并展示（执行期工具约束留后续）；**project/plugin 来源技能一律手动**（不进系统提示、不自动触发、模型 `skill` 工具会被拒），用户 `/skill` 仍可加载。`description` 支持 `|`/`>` 多行与引号。

**内置工具 | Built-in tools**：`read` / `glob` / `grep`（捆绑 ripgrep · bundled ripgrep）、`write` / `edit`（写入确认 + 模糊匹配 · confirmed writes with fuzzy matching）、`bash`（超时/后台任务、cd 跨调用持久 · timeout, background tasks, persistent working directory）、`task`（派生子代理 · spawn subagents: `general-purpose` 通用 / `explore` 只读搜索 / `.kcode/agents/*.md` 自定义 · custom agent files）、`todo`（任务面板 · task panel）、`ask_user`（结构化选择题 · structured questions）、`sessions`（历史会话查阅 · session history）。会话事件 JSONL 落盘 `~/.kcode/cli/sessions/`。

`todo` 清单每轮以 `<todo_state>` 回注模型（压缩/续接后仍可见）；后台控制面 `task_output` / `task_stop` / `task_list` / `task_wait` 对 bash 后台任务与后台子代理共用，长命令在途时看门狗放宽到 610s，避免被不活动判定误杀。

**存储治理**：`kcode sessions vacuum [--dry-run] [--max-sessions N] [--max-age-days N] [--max-artifact-mb N] [--max-audit-mb N]` 按年龄/数量/总量清理会话与产物、孤儿检查点/审计、过期子代理会话；`kcode sessions rm <id>` 级联删除该会话的产物/检查点/审计。

## 扩展系统 | Extensions

**钩子 Hooks**（`~/.kcode/hooks.json`；项目级 `.kcode/hooks.json` 需先 `/trust` 信任项目）：
```json
{ "hooks": [{ "event": "pre_tool_use", "command": "node ./guard.mjs", "matcher": "^bash$", "timeoutMs": 10000 }] }
```
事件：`session_start` / `pre_tool_use` / `post_tool_use` / `user_prompt_submit` / `pre_compact` / `stop`。命令经 shell 执行，stdin 收到 JSON 载荷；裁决协议：退出码 0 放行、退出码 2 拦截（stdout，缺省 stderr 作为原因）、stdout JSON `{action,args,reason,additionalContext}` 支持改参/拦截/上下文注入；超时/失败放行并告警（`failClosed:true` 则拦截，超时 1.5s 兜底结算不挂会话）。

- `matcher`（3-15）：工具名或正则（大小写不敏感），只对 `pre_tool_use`/`post_tool_use` 生效；`^bash$` 只拦 bash。
- `additionalContext`（3-15）：只回灌模型，不写工具事件/UI——`user_prompt_submit`/`session_start` 在本轮前注入，`pre/post_tool_use` 在工具结果后以 `<hook_context>` 追加。
- CC 兼容（3-15）：可直接用 Claude Code 的 `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"...","timeout":10}]}]}}` 形态；`timeout` 按秒、未知键只告警不拒绝。

**插件 Plugins**（`kcode plugin install <目录>`，清单 `.kcode-plugin`；项目级无需 trust，用户级缓存 `~/.kcode/cli/plugins`）：
- `hooks` 进入同一 runner（`source=plugin`，**cwd 为插件安装目录**，支持 `matcher`/`timeoutMs`/`failClosed`）。
- `mcp` 按 transport 分流：`stdio` 用 `command`/`args`/`env`；`http`/`sse` 用 `url`。
- `permissions` 只允许 `<工具名>:ask` 或 `<工具名>:deny`——**只能收紧，不能提权**；`allow`/未知格式在安装期拒装、加载期拒载，多插件冲突 deny 优先。
- 只装/只载**最新版本**：升级安装会清理旧版缓存，加载兜底只取同名最高版本。

**斜杠命令 Slash commands**：`.kcode/commands/<name>.md`（项目级）或 `~/.kcode/commands/<name>.md`（用户级），同名项目覆盖用户；子目录生成命名空间（`commands/git/commit.md` → `/git:commit`）。模板中 `$ARGUMENTS` 替换为命令后参数。

- **frontmatter（3-17，CC 兼容）**：`description` / `argument-hint` / `allowed-tools` / `model` 会被解析进补全与 `/help`，**不会**作为正文发给模型（未闭合的 `---` 也会剥掉）。`allowed-tools`/`model` 目前只做展示，执行期强制留给后续批次。
- **`!` bash（3-17）**：正文行首 `!`command`` 或 `!command` 在展开时经用户直执行通道运行（30s 超时、输出 8k 截断），结果以 `<bash_command>` 回填；围栏代码块内的 `!` 行不执行。
- 内置：`/plan` `/trust` `/help`。

**子代理 Agents**（`.kcode/agents/<name>.md` 需 `/trust`；用户级 `~/.kcode/agents/`；插件 `agents/` 需在 `.kcode-plugin` 的 `agents` 声明）：
frontmatter 支持 `description` / `tools` / `model` / `permissionMode`（`plan` 只读、`default`、`acceptEdits`）/ `disallowedTools` / `maxTurns`。`task` 工具按 `subagent_type` 派生隔离上下文的子代理；**plan 档只允许只读子代理**（`explore` 或声明 `permissionMode: plan`），`general-purpose` 会被拒绝，避免借子代理绕过只读姿态。

**MCP 服务器**（用户级 `~/.kcode/mcp.json`；项目级 `.kcode/mcp.json` 需先 `/trust`，同名项目覆盖用户；stdio 独立进程）：
```json
{ "servers": [{ "name": "fs", "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }] }
```
接入后工具命名为 `mcp__<服务器>__<工具>`，与内置工具同构——权限、钩子、审计对 MCP 工具同样生效。单个服务器失败不阻断会话。3-14 起：服务器声明 `annotations.readOnlyHint` 的工具在 plan 档放行；Esc 可立即取消进行中的 MCP 调用；图片内容落盘并交给视觉模型、`resource`/`structuredContent` 转为文本；传输断开自动重连重试一次；http/sse 支持 `headers`（远端 token），stdio 支持 `env`。

---

## P1 验收 | Acceptance

夹具仓库 mini-shop（埋浮点 bug / 错别字 / TODO / 硬编码密钥）+ 10 个任务，覆盖问答、写、精确/模糊编辑、bash、todo、ask_user、混合修复与**权限拒绝负向用例**；每任务独立工作区副本，按文件/事件/答案三重断言评分。
A fixture repo with seeded bugs plus 10 tasks covering Q&A, writing, exact/fuzzy edits, bash, todos, structured questions, a mixed fix, and a **permission-denial negative case**; each task runs in an isolated workspace copy scored on files/events/answer.

```bash
pnpm --filter @kcode/evals acceptance --scripted   # 框架自检（无网络，CI 已含）
export KCODE_ACCEPTANCE_MODEL="glm/glm-5.3"        # 真实模型 real model
pnpm --filter @kcode/evals acceptance
```

Windows 侧已实测 10/10（glm-5.3，约 8 分钟）；macOS 侧待跑（§9 双平台标准）。
10/10 verified on Windows with glm-5.3 (~8 min); macOS run pending (dual-platform standard).

---

## 开发 | Development

```bash
pnpm install          # 安装并链接 workspace / install & link workspace
pnpm verify           # 全门禁一键：typecheck/test/lint/依赖边界/knip/文档门禁/build
pnpm typecheck        # 逐包 tsc / per-package tsc
pnpm test             # 单测 + 回放 + E2E + 验收自检 / unit + replay + E2E + acceptance
pnpm lint             # oxlint
pnpm lint:deps        # dependency-cruiser 架构规则 / architecture rules (§4.2)
pnpm build            # tsup 构建库包 / build lib packages
```

手工验收清单见 [docs/testing-guide.md](./docs/testing-guide.md)（各优化项的启动方式、场景与观察点）。
See [docs/testing-guide.md](./docs/testing-guide.md) for manual acceptance scenarios.

包结构见 DESIGN.md §3.2 —— 包内一级目录 = 逻辑模块 = 后续拆包单元。
See DESIGN.md §3.2 for the package layout — first-level directories are logical modules and future split candidates.

CI（[.github/workflows/ci.yml](.github/workflows/ci.yml)）：Linux 门禁（typecheck/test/lint/依赖边界/knip/文档门禁/build）+ **Windows 全量测试**（Ink 交互渲染、真实路径/CRLF、DPAPI keychain、剪贴板、bash 进程树、host lease）+ desktop E2E；pnpm store 与 turbo `.turbo` 缓存，旧 run 自动取消。

CI runs the full Linux gate plus the **complete test suite on Windows** (Ink interactive rendering, real paths/CRLF, DPAPI keychain, clipboard, process trees, host lease) and desktop E2E, with pnpm-store and turbo caches.

## 安全设计速览 | Security at a Glance

- key 受众绑定 + 加密 keychain，**key 永不入仓库/云端** · Audience-bound keys in an encrypted keychain — keys never enter the repo or cloud（§5.7）
- 权限三态引擎 + 计划模式 + 无人值守 ask→deny 降级 · Tri-state permissions, plan mode, headless ask→deny downgrade（§5.5/§7）
- 会话/审计事件 append-only，支持回放 · Append-only session & audit events, replayable（ADR-7）
- 规划中：E2E epoch 加密、TUF 更新链、Sigstore 插件签名 · Planned: epoch E2E, TUF update chain, Sigstore plugin signing（§5.6/§5.8）

---

## License

[Apache-2.0](./LICENSE) · 商标（kcode 名称与标识）不在开源授权范围内，归项目所有方保留。
[Apache-2.0](./LICENSE) · The kcode name and logo are trademarks of the project owners and are not licensed under Apache-2.0.

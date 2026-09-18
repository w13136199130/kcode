# kcode（快码）

[![ci](https://github.com/w13136199130/kcode/actions/workflows/ci.yml/badge.svg)](https://github.com/w13136199130/kcode/actions/workflows/ci.yml)

> **本地优先的 AI 编程 Agent** —— 数据留在你的机器上，模型由你选择。
> **A local-first AI coding agent** — your data stays on your machine, and the model is your choice.

TypeScript 全栈实现对标 ZCode 形态：Agent 循环、权限沙箱、BYOK 多厂商模型接入、Ink 终端界面、技能与项目记忆、可回放会话，以及插件市场的完整规划。
A TypeScript implementation targeting ZCode-class capability: an agent loop, a permission sandbox, BYOK multi-vendor model access, an Ink TUI, skills & project memory, replayable sessions — with a full plugin-marketplace roadmap.

---

## 亮点 | Highlights

- 🔒 **key 永不上云** · **Keys never leave your machine** —— 受众绑定（key 只能发往 keychain 登记的端点，篡改即硬失败）+ AES-256-GCM 加密存储 / Audience-bound keys (a key can only be sent to endpoints registered in the keychain) with AES-256-GCM encrypted storage.
- 🛡️ **权限引擎** · **Permission engine** —— 读放行、写与命令逐次 y/N 确认、未知工具拒绝；`/plan` 一键进入只读计划模式 / Reads allowed, writes & commands require per-call y/N confirmation, unknown tools denied; `/plan` toggles a read-only planning mode.
- 🧩 **渐进式技能与记忆** · **Progressive skills & memory** —— SKILL.md 仅元数据常驻上下文，命中触发词才加载正文；AGENTS.md 项目记忆进稳定区 / SKILL.md metadata stays in context, the body loads only on trigger; AGENTS.md project memory in the stable zone.
- 📼 **可回放会话** · **Replayable sessions** —— JSONL append-only 事件流，回放一致性进 CI，天然作为 eval 夹具 / Append-only JSONL event stream with replay-consistency checks in CI — a natural source of eval fixtures.
- 🧪 **双模式验收** · **Dual-mode acceptance** —— scripted 框架自检进 CI；真实模型 10 任务评分（GLM-5.3 实测 **10/10** 通过）/ Scripted self-check in CI plus a 10-task real-model suite (10/10 with GLM-5.3).
- 🖥️ **Ink TUI** —— 流式输出、工具状态行、Todo 面板、结构化选择题、后台任务通知 / Streaming output, tool status rows, a todo panel, structured questions, background-task notices.

## 路线图进度 | Roadmap Status

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 地基 | monorepo / contracts / 会话回放 / CI 门禁 | ✅ |
| P1 单机 CLI | 工具链（rg/bash/write/edit）、providers、权限 v1、TUI、Plan/Todo/ask_user/图片 | ✅ 真实模型验收 10/10 |
| P2 上下文工程 | SKILL.md 渐进加载 ✅ · AGENTS.md 记忆 ✅ · resume/摘要压缩/token 曲线 | 🚧 进行中 |
| P3 扩展 + daemon | MCP / hooks / 插件 / 本地 API（UDS） | ⏳ |
| P4 账户 / 云 / 市场 | IdP / relay E2E / registry + Sigstore | ⏳ |
| P5–P6 | 自动化调度 / 电脑控制 | ⏳ |

完整设计（13 条 ADR、目录树、安全模型、企业就绪清单）见 [ARCHITECTURE.md](./ARCHITECTURE.md)。
Full design (13 ADRs, directory tree, security model, enterprise-readiness checklist) in [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 快速开始 | Quick Start

**前置 | Prerequisites**：Node.js ≥ 22 · pnpm ≥ 10 · Windows 需 Windows Terminal（§6）/ On Windows use Windows Terminal.

**1. 安装 | Install**

```bash
git clone https://github.com/w13136199130/kcode.git
cd kcode && pnpm install
```

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

REPL 内：`/plan` 切换计划模式（只读研究 → 确认后切回执行）；`exit` 退出。
In the REPL: `/plan` toggles plan mode (read-only research → switch back after approval); `exit` to quit.

**试试技能自动触发 | Try skill auto-trigger** —— 建一个技能目录（项目级 `.kcode/skills/<name>/SKILL.md`）：
Create a skill directory and mention a trigger word in your prompt:

```text
.kcode/skills/code-review/SKILL.md
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

**内置工具 | Built-in tools**：`read` / `glob` / `grep`（捆绑 ripgrep · bundled ripgrep）、`write` / `edit`（写入确认 + 模糊匹配 · confirmed writes with fuzzy matching）、`bash`（超时/后台任务 · timeout & background tasks）、`todo`（任务面板 · task panel）、`ask_user`（结构化选择题 · structured questions）。会话事件 JSONL 落盘 `~/.kcode/cli/sessions/`。

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
pnpm typecheck        # 逐包 tsc / per-package tsc
pnpm test             # 单测 + 回放 + E2E + 验收自检 / unit + replay + E2E + acceptance
pnpm lint             # oxlint
pnpm lint:deps        # dependency-cruiser 架构规则 / architecture rules (§4.2)
pnpm build            # tsup 构建库包 / build lib packages
```

包结构见 ARCHITECTURE.md §4.4 —— 包内一级目录 = 逻辑模块 = 后续拆包单元。
See ARCHITECTURE.md §4.4 for the package layout — first-level directories are logical modules and future split candidates.

## 安全设计速览 | Security at a Glance

- key 受众绑定 + 加密 keychain，**key 永不入仓库/云端** · Audience-bound keys in an encrypted keychain — keys never enter the repo or cloud（§5.7）
- 权限三态引擎 + 计划模式 + 无人值守 ask→deny 降级 · Tri-state permissions, plan mode, headless ask→deny downgrade（§5.5/§7）
- 会话/审计事件 append-only，支持回放 · Append-only session & audit events, replayable（ADR-7）
- 规划中：E2E epoch 加密、TUF 更新链、Sigstore 插件签名 · Planned: epoch E2E, TUF update chain, Sigstore plugin signing（§5.6/§5.8）

---

## License

[Apache-2.0](./LICENSE) · 商标（kcode 名称与标识）不在开源授权范围内，归项目所有方保留。
[Apache-2.0](./LICENSE) · The kcode name and logo are trademarks of the project owners and are not licensed under Apache-2.0.

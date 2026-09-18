# kcode（快码）

[![ci](https://github.com/w13136199130/kcode/actions/workflows/ci.yml/badge.svg)](https://github.com/w13136199130/kcode/actions/workflows/ci.yml)

本地优先 AI 编程 Agent。架构规范见 [ARCHITECTURE.md](./ARCHITECTURE.md)（v1.3，含 §4.4 完整目录树与 13 条 ADR）。

## 当前状态：P0 地基（§9）

- monorepo：pnpm workspaces + Turborepo；
- `packages/contracts`：v:1 JSONL 事件、Tool/Provider 接口、ProviderConfig 双作用域（防 key 外泄）、epoch 密钥层级、TUF manifest、`.kcode-plugin` 清单（路径正则）等全部共享 schema；
- `packages/core`：mock LLM 最小循环（消息→工具→回填）+ 权限/hook 管线 + cache 友好组装 + 压缩调度；
- `evals`：JSONL 夹具回放一致性测试（P0 验收：回放一段录制会话）；
- CI 三道门禁：typecheck / vitest / dependency-cruiser（§4.2 依赖规则）。

## 常用命令

```bash
pnpm install     # 安装并链接 workspace
pnpm typecheck   # turbo 逐包 tsc
pnpm test        # vitest（单测 + 回放）
pnpm lint:deps   # dependency-cruiser 依赖规则门禁
pnpm lint        # oxlint
pnpm build       # tsup 构建库包
```

## 包结构

见 ARCHITECTURE.md §4.4——包内一级目录 = 逻辑模块 = P3 后拆包单元。

## 试用（P1-3 端到端，BYOK）

**1. 写用户级配置** `~/.kcode/config.json`（`providers` 只允许在这一层，项目级无此字段——§5.7）：

```jsonc
{
  "models": {
    "default": "deepseek/deepseek-chat",
    "providers": {
      "deepseek": {
        "type": "openai-compatible",
        "baseURL": "https://api.deepseek.com/v1",
        "keyRef": "keychain://deepseek"
      },
      "ollama": { "type": "openai-compatible", "baseURL": "http://127.0.0.1:11434/v1" }
    }
  }
}
```

**2. 录入 key**（受众绑定：key 只发往登记的端点，§5.7）：

```bash
export KCODE_KEYCHAIN_PASSPHRASE="你的口令"      # 加密文件降级（P3 接 DPAPI/Keychain）
pnpm --filter @kcode/cli start key add keychain://deepseek sk-xxx https://api.deepseek.com/v1
pnpm --filter @kcode/cli start key list
```

Ollama 等本地无 key 端点跳过此步。

**3. 提问**（在目标仓库根目录，需 Windows Terminal §6）：

```bash
pnpm --filter @kcode/cli start                      # Ink TUI REPL（流式输出/工具状态/y-N 确认）
pnpm --filter @kcode/cli start "受众绑定校验在哪实现？"   # 一次性提问（可管道/脚本）
```

内置工具：read/glob/grep（捆绑 ripgrep）、write/edit（写入前 y/N 确认）、bash（PowerShell/bash，超时 + 后台任务，日志落盘 `~/.kcode/cli/artifacts/`）、todo（任务清单，TUI 面板渲染）、ask_user（结构化选择题）。REPL 命令：`/plan` 切换计划模式（只读研究 → 用户确认后切回执行）。附图：`start --image <路径> "这张图里是什么？"`。会话事件 JSONL 落盘 `~/.kcode/cli/sessions/`；权限默认预设=读放行、写/命令询问、未知拒绝（§7）。

## P1 验收（§9：真实仓库 10 任务）

验收框架内置于 evals：夹具仓库 mini-shop（埋浮点 bug / 错别字 / TODO / 硬编码密钥）+ 10 个任务（问答×2、写、精确/模糊编辑、bash、todo、ask_user、混合修复、**权限拒绝负向用例**），每任务独立工作区副本，按文件/事件/答案三重断言评分。

```bash
pnpm --filter @kcode/evals acceptance --scripted   # 框架自检（无网络，CI 已含，应 10/10）

# 真实模型验收（Windows 与 macOS 各跑一轮，§9 双平台标准）：
export KCODE_KEYCHAIN_PASSPHRASE="你的口令"
export KCODE_ACCEPTANCE_MODEL="deepseek/deepseek-chat"   # 或 ollama/qwen2.5-coder
pnpm --filter @kcode/evals acceptance
```


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

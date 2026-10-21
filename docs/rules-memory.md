# Rules 与项目记忆（4-07）

kcode 的规则分两层：**用户级规则**始终加载，**项目级规则**只在项目被 `/trust` 信任后加载，避免未信任仓库通过 `.kcode/rules` 注入提示词。

## 1. 规则目录

| 来源 | 目录 | 加载条件 |
|---|---|---|
| 用户级 | `~/.kcode/rules/*.md` | 始终 |
| 项目级 | `<cwd>/.kcode/rules/*.md` | 项目已 trust |

单文件上限 50 条规则、每条正文 8000 字符；非法/空文件跳过，不影响其它规则。

## 2. Frontmatter

```markdown
---
description: React 组件规范
paths:
  - "src/components/**/*.tsx"
  - "src/**/*.tsx"
alwaysApply: false
---

组件使用命名导出；样式与组件同目录。
```

字段：

| 字段 | 作用 |
|---|---|
| `alwaysApply: true` | 正文直接进入系统提示（受 `KCODE_RULES_CHARS` 预算限制） |
| `paths: [...]` | 路径作用域；命中目标文件时由 `rules` 工具加载正文 |
| `description` | 进入规则索引，帮助模型判断何时读取 |

只支持这个 YAML 子集；不使用 YAML 依赖，解析失败按无 frontmatter 处理（正文仍保留）。

## 3. 模型如何加载路径规则

系统提示只注入：

- `alwaysApply` 规则正文；
- 其它规则的**索引**（名称/描述/paths）。

模型改文件前可调用：

```text
rules path=src/components/Button.tsx
```

只返回命中该路径的规则正文；不传 `path` 时返回索引。

## 4. 项目自动记忆

目录：

```text
~/.kcode/projects/<workspace-key>/memory/*.md
```

- 启动时自动读取并注入 `<memory>` 块；
- 用户私有，不进入仓库、不随项目提交；
- 模型可用 `memory` 工具：
  - `action=list` 读取；
  - `action=add` + `text` 追加到 `notes.md`（写操作，走权限确认）。

`/remember` / `# 内容` 仍然写项目 `AGENTS.md`；两者用途不同：

- `AGENTS.md`：项目级、可提交、团队共享的长期约定；
- `projects/<key>/memory`：本机用户偏好与临时经验，不提交。

## 5. 开关

```powershell
$env:KCODE_RULES = "off"          # 关闭规则加载
$env:KCODE_MEMORY = "off"         # 关闭项目记忆
$env:KCODE_RULES_CHARS = "6000"   # alwaysApply 正文预算
```

## 6. 当前限制

- 路径规则不是“自动随每次工具调用注入”，而是索引 + `rules path=...` 按需读取；
- 没有规则优先级覆盖/冲突合并；
- 没有 UI 编辑器，直接编辑 markdown；
- 规则命中基于 glob 子集（`*`/`**`/`?`），不支持完整 gitignore 语义；
- 项目规则在未 trust 时完全不可见。

# B 级路线：Agent 能力核（2026-09 设计定稿）

> A 级体验轮（bash cd 持久 / 项目级放行 / /cost / LLM 重试 / /resume+多行 / Markdown 渲染）已于 2026-09 全部交付。
> 本文档是 B 级的对标分析结论与实施设计，是 P4（账户/云/市场）之前的产物主线。

## 1. 对标结论

对标对象：Claude Code（2026 现行版）、ZCode、OpenCode（SST）。

- **架构方向已对齐**：daemon + CLI 薄壳 = OpenCode 的 client/server 分离（多前端共享会话服务），甚至优于 Claude Code 的单进程形态。B 级不动架构，只往上垒能力。
- **核心差距在能力核**：子代理、计划工作流闭环、上下文工程质量。这三项决定产品是"好用的 CLI"还是"Agent 平台"。

### 各家关键设计（值得抄的）

| 来源 | 设计 | 借鉴点 |
|---|---|---|
| Claude Code | 权限五档 + Shift+Tab 循环切换 | 免命令的模式切换交互 |
| Claude Code | 子代理 = markdown 文件定义（`.claude/agents/*.md`，独立提示/工具集/权限） | `.kcode/agents/` 生态位 |
| Claude Code | 检查点：每次提交自动快照，/rewind 双击 Esc 同时回滚代码+对话，会话结束清理 | 对话侧 JSONL 事件流天然是检查点，补文件快照即可 |
| Claude Code | 压缩三层：microcompaction（工具结果提前卸载）→ auto（阈值触发）→ 手动 /compact；阈值宜早（~20% 剩余） | B3 直接对标 |
| ZCode | 交互即工具：结构化提问带 preview、计划门（ExitPlanMode 提交计划**等待用户批准**） | B2 的闸门设计 |
| ZCode | 子代理类型化（Explore 只读型）+ 上下文隔离 + 摘要回传 | explore 复用现有 READONLY_RULES |
| Claude Code | `@` 文件引用补全、`!` 直接执行 shell、`#` 快速写入记忆 | B4 交互包 |

## 2. B1 子代理系统（约 2 周）

**现状**：`AgentLoop` 构造器已是可实例化运行单元（ports 全注入、initialHistory、独立 model/systemPrompt）。缺的不是核心抽象，是组合层。

1. contracts：`TaskSpec`（type / prompt / description）。
2. daemon 组合层 `task` 工具：派生新 `AgentLoop`（复用 composeSession 装配路径，换工具集/权限，不落 UI 会话），同步阻塞；子代理**最终消息**作为 tool_result 回灌父上下文（上下文隔离：子代理不继承父历史）。
3. agent 定义：`.kcode/agents/<name>.md`（frontmatter: tools / model / description），内置 `general-purpose`（全套工具）与 `explore`（强制 READONLY_RULES）。
4. 并发与护栏：explore 子代理并行（复用 readOnly 并发机制）；子代理轮次上限 + 摘要截断（成本护栏）。

## 3. B2 计划双闸门 + /rewind 检查点（✅ 2026-09 交付）

- `plan_submit` 工具：模型在 plan 档产出计划后调用提交；UI 渲染计划全文 +「批准执行 / 继续研究 / 放弃」。
- **批准 = 切 default 档 + 计划文本写入上下文**——该计划同时成为压缩锚点（见 B3），一石二鸟。
- 检查点：写类工具执行前备份目标文件至 `artifacts/checkpoints/<callId>/`；`/rewind` 菜单列出回退点（对话=事件截断重建，文件=快照恢复）；双击 Esc 触发；会话关闭清理。

## 4. B3 上下文三层压缩（✅ 2026-09 交付）

- **micro**：tool result 回灌历史时超阈值截断（保留头尾，中部标记 `[已截断 N 行]`）。
- **auto**：阈值按模型 context window 归一化（deepseek 1M 与 glm 128K 不同线）；真 tokenizer（tiktoken 或按模型族系数表）替换 len/3；激活 budget.ts 的死代码配额。
- **manual**：`/compact` 命令。
- 锚点三级：系统提示 → 已批准计划 → 最近 N 轮；`/context` 可视化各区 token 占用。

## 5. B4 交互补齐包（✅ 2026-09 交付）

> 实际交付：Shift+Tab 权限循环、@ 文件引用补全、!命令 直执行（bash_run 协议）、
> 输入历史持久化（~/.kcode/cli/history.json）、/clear（清屏开新会话）、/status。
> /mcp 与 ask_user preview 移交 B5（与 MCP 改造同批）。

Shift+Tab 权限循环 + 状态栏常显档位；`@` 文件路径补全（glob 菜单注入路径）；`!命令` 直接执行 shell（结果进上下文）；输入历史持久化（`~/.kcode/cli/history.json`）；`/clear` `/status` `/mcp` `/context`；ask_user 增加 preview 参数。

## 6. B5 稳固性（约 1 周，可与主线并行插队）

- MCP callTool 超时（挂死拖轮是生产隐患）+ HTTP/SSE 传输。
- 原生 keychain：DPAPI（Windows）/ Keychain（macOS）——替代口令环境变量方案（新用户流失点）。
- hooks 事件扩充（UserPromptSubmit / PreCompact / Notification）+ fail-closed 可选。
- daemon 协议方法级协商（全局版本号已连跳 3→5，不可持续）。

## 7. 实施顺序与理由

```
B1 子代理 → B2 计划闸门+rewind → B3 上下文三层 → B4 交互包 → B5 稳固性（可插队）
```

B1 是能力核（后续 workflow / @补全都依赖）；B2 紧随其后因与 B3 锚点咬合（先有计划对象，压缩才有的放矢）；B4 是低风险细活可穿插；B5 随时插队（若要分发给他人使用，keychain 提前）。

B 级之后回到 ARCHITECTURE.md §9 的 P4 主线（账户/云/市场），P5+ 维持原砍单顺序。

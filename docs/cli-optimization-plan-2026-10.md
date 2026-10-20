# kcode CLI 优化执行方案（2026-10）

> 配套文档：[现状诊断](./cli-gap-analysis-2026-10.md) · [竞品基线](./cli-agent-benchmark-2026.md) · [桌面端方案](./desktop-plan-2026-10.md)
> 范围：本文是 **CLI 主线**（`apps/cli` + `packages/*`）。桌面端已纳入，见 [desktop-plan-2026-10.md](./desktop-plan-2026-10.md)；两者共享 `packages/*` 与同一会话语义，**CLI 阶段一（共享内核止血）仍是桌面的前置**。
> 目标版本：0.3「可信的 Windows 本地编码 agent」；0.4「日常顺手」；0.5「差异化」。
> 实施状态：阶段一 1-01~1-11 已落地（1-11 Windows CI 待首次 Actions 验证）；阶段二 2-01~2-24 已完成（脚本化契约 + 安全最小集 + 审批闭环 + 通知/模式同步 + 生成式 /help）。2026-10-20，记录见 [optimization-log-2026-10-19.md](./optimization-log-2026-10-19.md)。

---

## 0. 总原则与关键决策

### 0.1 优化目标

不是"把 ZCode 的 40 个工具补齐"，而是先让下面这句话成立：

> **在 Windows 上，一个新用户能在 2 分钟内完成配置，并可靠地完成"修一个失败测试"这件事；失败时看得到原因，改坏时能回退，退出后没有孤儿进程。**

这句话覆盖首用、权限、工具正确性、会话恢复、进程生命周期五条主链路。它成立之前，加功能都是负债。

### 0.2 四条原则

1. **先止血，再增强**：不可逆的数据丢失（resume/压缩）和 agent 判断错误（错误码/预算）优先于任何新功能。
2. **先可信，再自动化**：沙箱/策略之前，先把 env 清洗、读边界、SSRF、hook 顺序、项目 trust 做掉；否则 fullAccess/headless 是危险品。
3. **单链路闭环**：每个阶段只承诺一条端到端场景，做完再加下一条；不并行铺 5 个半成品。
4. **文档即代码**：每个"已实现"必须能指到一个测试或入口；文档状态三态化，禁止再写"已落地"而无证据。

### 0.3 五个关键决策（先拍板，避免返工）

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | resume 的语义 | **续写同一会话文件**（不是匿名 fork）；`--fork` 后续单独做 | 与 `apps/host/src/session.ts` 既有实现一致；否则 `-c` 会丢历史 |
| D2 | `-p` 的语义 | **有 `-p` 即无头**；交互用 `--interactive` 显式开启 | 脚本/管道/CI 的契约必须稳定，不能随 stdin 是否 TTY 变 |
| D3 | 安全基线 | 先做"最小可信执行"，Windows 原生沙箱放阶段四 | env 清洗/read 边界/SSRF/hook 复核成本低、收益立竿见影；沙箱成本高 |
| D4 | 扩展标准 | 只做"能互操作的最小集"：hooks matcher + 命令 frontmatter + skills 两字段 + MCP headers | 不做插件市场，但要让现有生态的配置能搬进来 |
| D5 | 阶段边界 | 阶段一/二未过出口标准，不启动阶段三的新工具/新命令 | 防止"功能广度继续挤压正确性" |

### 0.4 四阶段总览

| 阶段 | 主题 | 周期 | 一句话出口 |
|---|---|---|---|
| **1 止血** | 数据不丢、agent 不误判 | 第 1–2 周 | resume 两次不丢历史；压缩失败不吞历史；失败命令的 exit code 模型看得见 |
| **2 可信** | 进得来、敢脚本化、权限说得清 | 第 3–4 周 | 新机器 2 分钟跑通首任务；`-p` 管道干净；审批能看全命令/diff |
| **3 顺手** | 日常闭环 | 第 5–8 周 | 连续 3 天不用开第二个终端/编辑器 |
| **4 差异化** | Windows 沙箱、LSP、fork、记忆 | 第 9–16 周 | 在 Windows 上做到别人没做好的隔离与代码理解 |

---

## 1. 阶段一：止血（第 1–2 周）

**主题：让"数据不丢、agent 不误判"。**
**出口标准：** 下面 7 个回归测试全绿，且 `pnpm test` 在 Windows runner 上通过。

### 1.1 任务清单

| ID | 动作 | 落点 | 验收 | 人日 |
|---|---|---|---|---|
| 1-01 | **resume 透传 sessionId**：`resolveResumeHistory` 返回源 `sessionId`，`createSession` 传给 `composeSession`；若产品要保留 fork 语义，另开 `--fork` | `apps/cli/src/session.ts`、`packages/session/src/resume.ts` | A→B→B 三次续接后，历史仍包含 A 全部消息；`/cost` 累计不丢 | 0.5 |
| 1-02 | **resume 二次续接回归测试**：真实 JSONL 落盘 + 两次 resolve | `packages/session/test/resume-continuity.test.ts` | 测试在旧代码上必红、新代码绿 | 0.5 |
| 1-03 | **摘要失败必须抛**：`LlmSummarizer` 检查 `end.reason==="error"` 与空结果；`runCompaction` 只在摘要有长度时应用 | `packages/platform/src/providers/summarizer.ts`、`packages/core/src/context/compact.ts` | 模拟 401/429，历史与 `compactFailures` 均不被改写；手动 `/compact` 上抛错误 | 1 |
| 1-04 | **压缩熔断后的机械兜底**：连续 3 次失败后不再尝试 LLM 摘要，改为"首问锚点 + 最近 K 轮"硬截断，并在 UI 明示 | `packages/core/src/core/loop.ts`、`packages/core/src/context/compact.ts` | 摘要端点全坏时，长会话仍可继续，不撞上下文上限 | 1 |
| 1-05 | **工具失败原因回灌**：`settleToolResults`/`replayer` 在 `ok===false` 时把 `error` 前置到 content；`ToolOutput` 增 `meta.exitCode/truncated/artifactPath` | `packages/core/src/core/settle-results.ts`、`packages/runtime/src/session/replayer.ts`、`packages/contracts/src/tool.ts` | 失败 bash 带 stdout 时，历史里能看到 `[exit code 1]`；模型下一轮会重试/修正 | 1 |
| 1-06 | **回灌预算按 token 重算**：`capToolResult` 改为按 `estimateTokens` 二分前缀/后缀；read 默认 limit 降到 token 安全值，输出"已显示 1-x / 共 N 行，用 offset=x+1 继续" | `packages/core/src/context/budget.ts`、`packages/tools/src/tools/read.ts` | ASCII/CJK 两组用例都落在预算 ±10% 内；read 不再宣称给了 2000 行 | 1.5 |
| 1-07 | **统一工具内部 cap 与 resultBudget**：grep 64k/extract 60k/web 40k/bash 30k 与 `resultBudget` 对齐，超限必须带续读/artifact 方法 | 各工具定义 | 不存在"内部 cap 永远到不了"的死代码 | 1 |
| 1-08 | **edit EOL 归一**：`countOccurrences` 前把 content/oldString 归一到 `\n`（记录原 EOL 还原）；先精确、再 `\r\n` 变体、最后模糊 | `packages/tools/src/tools/edit.ts` | CRLF 仓库多行编辑走精确路径；混合 EOL 不被整篇改写 | 1 |
| 1-09 | **workspace 边界修正**：抽 `isWithinWorkspace`（`relative` + `isAbsolute` + `..` 前缀），write/edit/bash 共用；跨盘/UNC 用例 | `packages/tools/src/tools/paths.ts`、`write.ts`、`edit.ts`、`bash.ts` | `E:\ws` 写 `D:\x` 被拒；同盘越界仍拒；错误信息可操作 | 1 |
| 1-10 | **预算计入 toolCalls.args 与图片**：`historyTokens` 加 `JSON.stringify(args)` 与每图固定估值；大 write 参数回灌时替换为"摘要+字数" | `packages/core/src/context/budget.ts`、`settle-results.ts` | 写 50k token 文件后 `/context` 能看见；不会静默溢出 | 1 |
| 1-11 | **Windows CI 最小回归**：GitHub Actions 加 `windows-latest` job（typecheck + 路径/CRLF/DPAPI 相关测试） | `.github/workflows/ci.yml` | Windows job 绿；失败能定位到用例 | 0.5 |

**小计：约 10 人日。** 1-01/1-03/1-05 三个人日收益最大，先做。

### 1.2 执行顺序

```
1-01 → 1-02 → 1-03 → 1-04 → 1-05 → 1-06 → 1-07 → 1-08 → 1-09 → 1-10 → 1-11
```

1-01/1-02 是"数据不丢"，1-03/1-04 是"压缩不吞"，1-05 是"agent 不瞎"，1-06/1-07 是"agent 不饿"，1-08/1-09 是"Windows 能改"，1-10 是"不静默溢出"，1-11 是"以后不再回归"。

### 1.3 阶段出口（Definition of Done）

- [ ] `resume-continuity`、`compact-failure`、`bash-failure-with-output`、`crlf-edit`、`cross-drive-write`、`context-budget-cjk`、`windows-ci` 七个测试存在且绿。
- [ ] `pnpm typecheck && pnpm test && pnpm lint` 在 Linux + Windows 都过。
- [ ] 手工场景：`kcode -c` 两次不丢历史；断网触发压缩失败后继续对话不丢历史；`npm test` 失败后模型说"测试失败"而不是"通过"。

---

## 2. 阶段二：可信（第 3–4 周）

**主题：让新用户进得来、让脚本敢用、让权限说得清。**
**出口标准：** 全新机器 2 分钟内完成配置并跑通首个任务；`kcode -p "..."` 在管道/CI 中行为稳定；审批面板能看清完整命令/diff；不存在"批准后仍被拒"。

### 2.1 首用与配置

| ID | 动作 | 落点 | 验收 | 人日 |
|---|---|---|---|---|
| 2-01 | **顶层 `kcode login` / `kcode init`**：无 config 也能进 TUI 的 unconfigured 模式，banner 直接给 `/login`；或 CLI 子命令完成登录 | `apps/cli/src/main.tsx`、`bootstrap.ts`、`args.ts`、`tui/state/lifecycle.ts` | 删掉 `~/.kcode/config.json` 后 `kcode` 仍能启动并完成登录 | 2 |
| 2-02 | **LLM 延迟解析**：`composeSession` 初始不强制 `llmFactory`，第一次请求前再解析 key | `packages/session/src/composition.ts` | 没有 key 也能进 TUI、能打开 `/login` | 1 |
| 2-03 | **`/login` 配置合并**：读旧配置 → provider 级 merge → 保留 budget/其他根字段 → 原子写 + 备份；保存后热重建 router 或明确提示重启 | `apps/cli/src/tui/dialogs/LoginWizardPanel.tsx`、`bootstrap.ts` | 已有 glm+deepseek 再加 kimi，三者都在；budget 不丢 | 1.5 |
| 2-04 | **`--help/-h` 与错误出口**：在任何 IO 之前处理；未知 flag 只打一行 + usage，exit 2；`-v` 让给 verbose，版本用 `--version` | `apps/cli/src/args.ts`、`main.tsx` | `kcode --help` 正常；`kcode --bad` 不打印 stack | 0.5 |
| 2-05 | **fatal 不再 80ms 退出**：显示错误 + `r` 重试 / `q` 退出 + 可复制的修复命令 | `apps/cli/src/tui/state/lifecycle.ts` | 缺 key/配置错时用户能读到并操作 | 0.5 |
| 2-06 | **配置层级最小化落地**：`KCODE_HOME`、`--settings`、项目 `.kcode/config.json`（非 provider 字段）真正生效；`UserConfigFile.strict()` 改为未知键告警不阻断 | `bootstrap.ts`、`contracts/provider.ts` | CI/多 profile 可隔离；项目可覆盖 default/mode | 2 |

### 2.2 脚本化契约

| ID | 动作 | 落点 | 验收 | 人日 |
|---|---|---|---|---|
| 2-07 | **`-p` 恒无头**：新增 `--interactive`；stdout 是管道时绝不渲染 Ink | `main.tsx` | `kcode -p "x" | jq` 输出干净 NDJSON/文本；pty 下同样 | 1 |
| 2-08 | **stdin 管道输入**：`cat log.txt | kcode -p "explain"` 把 stdin 内容作为上下文；`-` 表示 heredoc | `headless.ts` | 管道内容进入 prompt；空 stdin 不阻塞 | 1 |
| 2-09 | **`--mode` 交互态生效**：传给 `KcodeApp.initialMode`；fullAccess 在 TTY 二次确认 | `main.tsx`、`App.tsx` | `kcode --mode plan` 直接进只读；状态栏显示只读 | 0.5 |
| 2-10 | **`--disallowed-tools` 透传 TUI**：不静默忽略；未知名 fail-fast | `main.tsx`、`lifecycle.ts`、`session.ts` | 交互态剔掉 bash 后模型看不到该工具 | 0.5 |
| 2-11 | **退出码契约**：0 成功 / 1 通用失败 / 2 参数/配置 / 3 认证 / 4 模型 API / 130 中断；headless result 带 `permissionDenials/toolFailures/usage`；有 deny 且 completed 时改状态 | `headless.ts`、`main.tsx`、`contracts` | CI 能区分"没权限"与"成功"；不会假绿 | 1.5 |
| 2-12 | **`--output-format` / `--max-turns` / `--ephemeral` / `--session-id`**：至少支持 `text|json|stream-json`，max-turns 可配，ephemeral 不落盘 | `args.ts`、`headless.ts`、`composition.ts` | 脚本可约束轮次与输出格式；CI 不产生垃圾会话 | 2 |

### 2.3 安全最小集

| ID | 动作 | 落点 | 验收 | 人日 |
|---|---|---|---|---|
| 2-13 | **bash 子进程 env 清洗**：剥掉 `KCODE_KEYCHAIN_PASSPHRASE` 与常见 secret env；只透传白名单 | `packages/tools/src/tools/bash.ts` | `echo $KCODE_KEYCHAIN_PASSPHRASE` 为空；`env` 看不到口令 | 0.5 |
| 2-14 | **read/grep/glob 敏感路径 denylist + 工作区外提示**：`.env*`、`.ssh/**`、`id_*`、`.aws/**`、`.git-credentials` → ask/deny | `packages/extensions/src/permissions/`、工具层 | 读 `.ssh/id_rsa` 需确认或被拒；审计可见 | 1 |
| 2-15 | **web_fetch 逐跳 SSRF**：`redirect:"manual"` + 每跳复检 + DNS 解析后 IP 校验；补 IPv6 ULA/link-local/0.0.0.0/整型 IPv4 | `packages/tools/src/tools/web.ts` | 公网 302 到 127.0.0.1 被拒；测试覆盖 | 1 |
| 2-16 | **hook 改参后重新判权**：`pre_tool_use` mutate 后重跑权限引擎；审批展示最终参数 | `packages/core/src/core/pipeline.ts` | hook 把 `ls` 改成 `rm -rf` 时重新 ask | 1 |
| 2-17 | **项目扩展 trust 门控**：项目 `.kcode/skills|agents|commands` 与 hooks 一样需 `/trust`；未信任只列不算 | `packages/extensions/src/roots.ts`、`composition.ts` | 克隆陌生仓库、输入触发词不会自动注入 SKILL.md | 1 |
| 2-18 | **key 录入不走 argv + keychain 原子写**：隐藏输入/`--key-file`；tmp+rename+.bak | `main.tsx`、`platform/src/auth/keychain.ts` | 进程列表/历史看不到 key；崩溃不丢全部 key | 1 |
| 2-19 | **update 链收紧**：强制 https（本地需 `--local`）；latest.json 验签或至少 pin 公钥；`tar -tzf` 逐条校验路径；保留上一版 + `--rollback` | `apps/cli/src/update.ts` | 篡改包被拒；`../` 不能写出 staging；可回滚 | 2 |

### 2.4 审批与交互一致性

| ID | 动作 | 落点 | 验收 | 人日 |
|---|---|---|---|---|
| 2-20 | **审批完整信息**：bash 显示完整命令（换行/滚动），edit/write 完整 diff（分页）；默认高亮"拒绝"或必须显式选择 | `tui/dialogs/panels.tsx`、`DiffPreview.tsx`、`OptionsMenu.tsx` | 100 字符命令/100 行 diff 可完整查看；Enter 不误放行 | 1.5 |
| 2-21 | **会话级放行参数级化**：复用 `suggestGrant`，文案显示将保存规则；或明确写"本会话允许所有 bash" | `panels.tsx`、`composition.ts`、`engine.ts` | 允许一次 `bash ls` 不会放行 `rm -rf` | 1 |
| 2-22 | **审批/提问通知**：ask/plan/question 出现时响铃 + 标题"需要确认" | `state/interactions.ts`、`terminal/notify.ts`、`title.ts` | 切走后能知道在等确认 | 0.5 |
| 2-23 | **模式同步**：所有 `createSession` 传 `initialMode`；Shift+Tab 删重复 handler，统一 `!busy && !menuOccupied && !overlay` | `commands.ts`、`lifecycle.ts`、`keybinds.ts` | `/clear`/`/resume` 后 UI 与引擎档位一致；一次按键一条提示 | 0.5 |
| 2-24 | **`/help` 生成化**：从 `BUILTIN_COMMANDS` + keymap 表生成；修 `/ctx.mode`、补 `/export` `/hooks` 与 Ctrl+J/O/B/T/R/E/V | `builtin-commands.ts`、`commands.ts` | 帮助与菜单/键位零漂移 | 1 |

**小计：约 28 人日。** 如果只有 1 人，砍掉 2-06/2-12/2-18/2-19 到阶段三，保留 2-01~2-05、2-07~2-11、2-13~2-17、2-20~2-24。

### 2.5 阶段出口

- [ ] 全新 Windows 机器：安装 → `kcode login` → 首个任务，≤2 分钟，无需手写 JSON。
- [ ] `printf "..." | kcode -p "..." --output-format stream-json` 可被脚本消费；退出码能区分失败类型。
- [ ] 审批面板可完整查看命令/diff；默认不误放行；会话级放行不扩大到整工具。
- [ ] `echo $KCODE_KEYCHAIN_PASSPHRASE` 为空；读敏感路径触发确认；302 到内网被拒；hook 改参被复核。
- [ ] `/clear`/`/resume` 后状态栏档位与引擎一致。

---

## 3. 阶段三：顺手（第 5–8 周）

**主题：把"日常使用摩擦"降到可接受。**
**出口标准：** 一个真实项目连续用 3 天，不出现"必须开另一个终端/编辑器才能继续"的场景。

### 3.1 会话恢复与生命周期

| ID | 动作 | 落点 | 验收 | 人日 |
|---|---|---|---|---|
| 3-01 | **resume 重放转写**：从事件流重建最近 K 条 user/assistant/tool 块；或提供 `/transcript` 分页 | `lifecycle.ts`、`transcript` 层 | `--resume` 后能看到历史，不是空白 | 1.5 |
| 3-02 | **图片持久化**：`user_message` 增 `images`；resume/rewind 恢复 | `contracts/session.ts`、`loop.ts`、`replayer.ts` | 重启后图片上下文仍在 | 1 |
| 3-03 | **切换/退出关闭旧会话**：`await old.close()`；SIGINT/SIGTERM handler；close 里停后台任务、等 runner 收尾 | `App.tsx`、`main.tsx`、`composition.ts` | 退出后无 MCP/后台 bash/子代理孤儿；session_end/usage 落盘 | 1.5 |
| 3-04 | **`/resume` 按当前项目 + 命名/删除**：列表按 workspaceKey 过滤、按 mtime 排序；`session_start` 增 title/tags；`kcode sessions rm` | `runtime/session/resume.ts`、`session.ts`、`commands.ts` | 多项目下菜单只显示当前项目；可命名/删除 | 2 |
| 3-05 | **检查点配额与子代理范围**：内容 hash 去重、单会话上限、restore 用 copy、失败计数；rewind 收集子代理 callId | `checkpoints.ts`、`rewind.ts` | 大文件编辑不膨胀；rewind 不再"半回滚" | 2 |
| 3-06 | **`/export` 走 JSONL**：导出完整事件（含工具全文），Markdown 只是渲染；支持历史会话 | `tui/export.ts`、`commands.ts` | 导出可作为交付物；工具输出不丢 | 1 |

### 3.2 工具闭环

| ID | 动作 | 落点 | 验收 | 人日 |
|---|---|---|---|---|
| 3-07 | **新增 `apply_patch`（多文件原子补丁）**：一次 ask、一次 checkpoint、全成或全不成 | `packages/tools`、`contracts/tool.ts` | 多文件重构一次确认；失败不半写 | 3 |
| 3-08 | **`edit.replaceAll` + 多组 edits**：减少 N 次调用/N 次确认 | `edit.ts` | 全量替换/多 hunk 一次完成 | 1 |
| 3-09 | **读后过期校验**：`ToolContext` 维护 read 表（path+mtime/hash）；write/edit 对已存在文件要求"读过且未变" | `loop.ts`、`write.ts`、`edit.ts` | 覆盖用户手改会被拒并提示重新 read | 2 |
| 3-10 | **bash 体验**：artifact 路径前置、超时保留已产生输出、超时/中断 abort 进程树、`timeoutMs` 上限、输出流式回显 | `bash.ts`、`output-collector.ts`、`pipeline.ts` | `npm run build` 超时能看到错误；长命令有实时输出 | 2 |
| 3-11 | **grep/glob 补齐**：grep 总数上限 + `-C/-U/-t/-l` + offset；glob 读 .gitignore、mtime 排序、反斜杠归一 | `grep.ts`、`glob.ts` | 与 rg 语义一致；模型不用绕 bash | 1.5 |
| 3-12 | **文档抽取修复**：XLSX 公式/超链接/错误值/本地日期；PDF 空页提示；PPTX/CSV；DOCX 结构 | `extract.ts` | 读表格不再 `[object Object]`；扫描件有明确提示 | 2.5 |
| 3-13 | **todo 回注 + task 治理**：每轮注入 `<todo_state>`；task 看门狗心跳、usage 汇总、`task_list`/`wait` | `loop.ts`、`todo.ts`、`subagent.ts`、`task-tools.ts` | resume/压缩后模型知道清单；长命令不被误杀；/cost 含子代理 | 2 |
| 3-14 | **MCP 能力补齐**：annotations.readOnlyHint、signal 透传、图片/结构化内容、失败重连、项目级 `.kcode/mcp.json`（trust 门控）、headers/env | `mcp/provider.ts`、`contracts/mcp.ts`、`mcp-cmd.ts` | 只读 MCP 在 plan 可用；Esc 能取消；远端带 token 可用 | 3 |

### 3.3 扩展与模型

| ID | 动作 | 落点 | 验收 | 人日 |
|---|---|---|---|---|
| 3-15 | **hooks matcher + 上下文注入 + 协议兼容**：`matcher`（工具名/正则）、`additionalContext`、兼容 CC JSON、条目未知键只告警 | `contracts/hooks.ts`、`hooks/runner.ts` | 只对目标工具跑 hook；支持上下文注入 | 2 |
| 3-16 | **插件接线**：manifest.hooks 进 hook runner（source=plugin）、permissions 转规则或拒装、MCP 按 transport 分流、只装最新版 | `composition.ts`、`plugins/install.ts` | 同意摘要里写的内容真的生效 | 2 |
| 3-17 | **命令 frontmatter / `!bash` / 命名空间**：description/argument-hint/allowed-tools/model；递归目录生成 `ns:cmd`；不再把 `---` 发模型 | `extensions/src/commands/` | CC 风格命令可直接用 | 2 |
| 3-18 | **skills 两字段 + 来源策略**：`allowed-tools`、`disable-model-invocation`；第三方技能默认手动；解析器支持多行/引号 | `contracts/skill.ts`、`skills/` | 项目/插件技能不会静默自动注入 | 1.5 |
| 3-19 | **subagent 扩展**：`permissionMode`、`disallowedTools`、`maxTurns`、插件来源；`explore` 在 plan 档可用 | `contracts/agent.ts`、`session/src/subagent.ts` | 只读子代理可声明只读；plan 能派 research | 1.5 |
| 3-20 | **模型层**：请求/空闲超时、上下文溢出自动 compact+retry、headers/代理、modelRef 支持 `:` 与嵌套 `/`、`env:` keyRef、窗口表可配 | `openai-compatible.ts`、`provider.ts`、`budget.ts` | 断网/超限不再挂死；Ollama tag/OpenRouter 可用；CI 可用 env key | 3 |
| 3-21 | **费用与用量**：cache token、按模型/子代理/压缩分项；`/usage` | `contracts/usage.ts`、`loop.ts`、`commands.ts` | `/cost` 能解释钱花在哪 | 1.5 |

### 3.4 TUI 体验

| ID | 动作 | 落点 | 验收 | 人日 |
|---|---|---|---|---|
| 3-22 | **长输出可查看**：工具详情分页/搜索/复制；错误默认显示尾部；给出 JSONL/artifact 路径 | `Transcript.tsx`、`ToolBrowser.tsx`、`events.ts` | 1000 行测试失败能在 TUI 里看完 | 2 |
| 3-23 | **diff 审查**：`/diff [文件]` 列出 changed files + hunks；逐文件 revert（复用 checkpoint） | `commands.ts`、新面板 | 改完能在 CLI 内 review，不必切 git | 3 |
| 3-24 | **输入编辑键**：Ctrl+A/E/U/K/W、Alt/Ctrl+左右词移动；外部编辑器改 Ctrl+G；Ctrl+J 写进帮助/ghost | `InputBox.tsx`、`InputArea.tsx` | 长提示词可正常编辑 | 1.5 |
| 3-25 | **Static 修复**：活区维护"所有 running 工具"而非只看尾部；终态独立 live 卡；Ctrl+O 强制重放/分页 | `TranscriptView.tsx`、`store.ts` | 排队提示/子代理事件不再冻结工具卡；Ctrl+O 真能展开 | 1.5 |
| 3-26 | **终端安全与降级**：剥离 ESC/OSC（保留自家 OSC8）；`NO_COLOR`/`KCODE_PLAIN=1`；亮色主题/ASCII glyph | `Transcript.tsx`、`markdown.tsx`、`design/terminal.ts` | 恶意输出不能改标题/写剪贴板；白底可读 | 2 |
| 3-27 | **后台任务可见**：状态栏 `⚙ N`、完成铃声、`/tasks` + stop；审批/提问通知 | `StatusLine.tsx`、`notify.ts`、`tasks/` | 切走知道完成；能停 | 1.5 |
| 3-28 | **`#` / `/` 输入边界**：`#` 改为 `# ` 或 `/remember`；未知 `/` 命令保留原文；`/Users/...` 可发送 | `InputArea.tsx`、`commands.ts` | 不再误写 AGENTS.md / 丢输入 | 1 |

### 3.5 工程与治理

| ID | 动作 | 落点 | 验收 | 人日 |
|---|---|---|---|---|
| 3-29 | **审计落盘**：`AuditSink` 写 JSONL/独立文件（工具、决策、scope、耗时）；MemoryAudit 仅供测试 | `composition.ts`、`shared/logger` | 能回答"谁在何时允许了什么" | 1 |
| 3-30 | **保留策略**：sessions/artifacts/checkpoints 配额与清理；`kcode sessions vacuum/rm` | runtime/session | 长期使用磁盘不失控 | 1.5 |
| 3-31 | **文档对账**：DESIGN 全部"已落地"三态化并附测试/入口；`gates:check` 校验链接存在 | `DESIGN.md`、`scripts/gates-check.mjs` | 不再出现"文档说完成、代码没有" | 2 |
| 3-32 | **Windows CI 扩展**：交互测试（Ink render）+ 真实路径/DPAPI/clipboard | `.github/workflows/ci.yml` | Windows 回归可发现 | 1 |

**小计：约 58 人日。** 3 人并行约 4 周；1 人约 11–12 周。若只有 1 人，按 3-01/3-03/3-07/3-08/3-09/3-10/3-20/3-22/3-25/3-26/3-31 排序，其余延后。

### 3.6 阶段出口

- [ ] 连续 3 天真实项目使用，不需要开第二个终端看日志/做 diff/恢复会话。
- [ ] `apply_patch` + 读后校验 + diff review 组成"改得准、看得见、退得回"闭环。
- [ ] 断网、超时、429、上下文溢出四种异常都有可恢复路径。
- [ ] 项目技能/命令/hooks/MCP 的加载边界与 `/trust` 一致。
- [ ] TUI 长输出、diff、输入编辑、主题、后台任务达到"无明显高频摩擦"。

---

## 4. 阶段四：拉开差距（第 9–16 周）

**主题：做别人在 Windows 上没做好的事；不做别人已经做烂的事。**

| ID | 方向 | 动作 | 验收 | 人日 |
|---|---|---|---|---|
| 4-01 | **Windows 原生沙箱** | restricted token + job object；read-only / workspace-write 两档；网络默认关；沙箱升级审批 once/session/policy | 沙箱内 `kcode -p` 可改工作区、不可写系统目录、不可联网；越权有明确提示 | 15–20（原型+生产化） |
| 4-02 | **策略文件** | `.kcode/policy.toml` 或 JSON：allow/ask/deny + commandPrefix + priority；PowerShell/bash 双语法 | 能声明"永不执行 rm -rf / del /s / git push --force" | 4 |
| 4-03 | **LSP/diagnostics** | 编辑后收集 tsc/eslint/pyright 诊断，作为工具结果回灌；`diagnostics` 工具 | 改完文件能立即看到类型错误，不必模型自己跑全量 | 6–8 |
| 4-04 | **repo map** | tree-sitter 或 rg + 结构摘要；按 token 预算注入 | 大仓问答/定位不再靠盲搜 | 6–8 |
| 4-05 | **会话 fork/命名/搜索** | `--fork`、`/rename`、跨会话全文搜索、删除/归档 | 能从任意一轮开分支；能找回历史 | 5–7 |
| 4-06 | **消息级编辑/重发** | 选中某条 user 消息 → 编辑 → 截断后续 → 重发；与 checkpoint 联动 | 不必每次回退到轮首 | 5 |
| 4-07 | **auto memory + 路径作用域规则** | `~/.kcode/projects/<key>/memory/`；`.kcode/rules/*.md` + `paths:` frontmatter 按需加载 | 跨会话记住偏好；子目录规则按需生效 | 5–7 |
| 4-08 | **插件签名与加载期校验**（不做市场） | 本地/Sigstore 签名、安装确认、加载期重校验 | 篡改拒载；安装前可确认 | 6–8 |
| 4-09 | **IDE/ACP** | `kcode acp` 作为 ACP server；VS Code 选区/诊断桥 | Zed/其他编辑器可把 kcode 当外部 agent | 6–8 |

**建议**：4-01/4-02 是 Windows 差异化的核心，优先于 4-03/4-04；4-08/4-09 在 CLI 稳定后再评估。

---

## 5. 排期与人力

| 阶段 | 周期 | 人日（估） | 3 人并行 | 1 人 |
|---|---|---|---|---|
| 一 止血 | 2 周 | ~10 | 1 周 | 2 周 |
| 二 可信 | 2–2.5 周 | ~28 | 2 周 | 5.5 周 |
| 三 顺手 | 4 周 | ~58 | 4 周 | 11–12 周 |
| 四 差异化 | 8 周 | ~60–75 | 6–8 周 | 12–16 周 |

> 人日是按当前代码结构与测试基础估算的量级，不是承诺。阶段二/三有并行空间（入口、工具、TUI 三条线），但**阶段一必须串行做完再开工**。

### 5.1 建议分工（3 人）

- **A（引擎/会话）**：阶段一 1-01~1-05、1-10；阶段二 2-02/2-11/2-12/2-16；阶段三 3-01~3-06、3-09、3-13、3-20。
- **B（工具/扩展）**：阶段一 1-06~1-09；阶段二 2-13~2-19；阶段三 3-07/3-08/3-10~3-12/3-14~3-19。
- **C（TUI/入口）**：阶段一 1-11；阶段二 2-01/2-03~2-10/2-20~2-24；阶段三 3-21~3-28、3-30~3-32。

阶段四按兴趣/风险重新分配；4-01 建议由最懂 Windows 的人主导。

---

## 6. 验收与度量

### 6.1 回归测试（必须新增）

| 测试 | 覆盖 | 阶段 |
|---|---|---|
| `resume-continuity` | A→B→B 不丢历史；`/cost` 累计 | 一 |
| `compact-failure` | 摘要 401/429 不吞历史；熔断后机械截断 | 一 |
| `bash-failure-with-output` | 失败命令的 exit code 进入历史 | 一 |
| `context-budget-cjk` | ASCII/CJK 两种预算误差 ≤10% | 一 |
| `crlf-edit` | CRLF 文件精确编辑；混合 EOL 保留 | 一 |
| `cross-drive-write` | Windows 跨盘越界被拒 | 一 |
| `first-run` | 无 config 进 TUI → `/login` → 首任务 | 二 |
| `headless-contract` | `-p` 恒无头；stdin；退出码；stream-json | 二 |
| `env-scrub` | bash 看不到 `KCODE_*` secret | 二 |
| `ssrf-redirect` | 302 到内网被拒 | 二 |
| `hook-mutate-permission` | 改参后重新判权 | 二 |
| `approval-full-view` | 完整命令/diff 可查看；Enter 不误放行 | 二 |
| `resume-transcript` | 恢复后能看到历史 | 三 |
| `static-running-tool` | 排队提示不冻结工具卡 | 三 |
| `terminal-escape` | OSC/ESC 被剥离 | 三 |
| `sandbox-windows` | 沙箱内写边界/网络 | 四 |

### 6.2 eval 扩展

在现有 mini-shop 10 任务上增加 3 个"真实痛点"任务：

1. **修一个失败测试**：仓库带一个失败单测，模型必须跑测试、读失败、改代码、再跑通过。
2. **大文件/多文件改动**：1000 行文件 + 3 个文件，考察 read 续读、apply_patch、diff。
3. **CRLF + 中文路径**：Windows 仓库，考察 EOL、编码、路径。

指标：通过率、平均轮次、工具调用次数、token 消耗、失败原因分类（权限/超时/上下文/工具错误）。

### 6.3 体验指标

- 首次配置到首任务：≤2 分钟（Windows，含 key 录入）。
- `kcode -p` 管道输出：0 个 ANSI 转义（`--output-format text` 时）。
- 退出后残留进程：0（MCP/后台 bash/子代理）。
- 长会话（100+ 轮）内存：稳定，不随 blocks 线性爆。
- 断网/429/超时：全部有可恢复路径，不挂死。
- 审计：每条工具决策可查（谁、何时、什么规则、scope）。

---

## 7. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| resume 改成续写同一文件后，用户想"从某轮开分支" | 行为变化 | 阶段一先按续写修复；阶段四提供 `--fork`，文档明确两者差异 |
| 压缩失败改为抛错后，长会话更容易中断 | 体验 | 同时上机械截断兜底；失败只降级不阻断 |
| `-p` 恒无头改变现有 TUI 用法 | 兼容 | 提供 `--interactive`；release notes 写明 |
| 安全收紧（read 边界/env 清洗）导致某些工作流失败 | 抱怨 | 先告警+可配置 allowlist；denylist 只覆盖高敏路径 |
| 阶段三新增工具/命令再次挤压正确性 | 回归 | 阶段出口门禁 + 每新增工具必须带 resultBudget/timeout/权限声明/测试 |
| 文档对账工作量大 | 拖延 | 只对 DESIGN 的"已落地"做一次性扫描；之后新增条目必须附测试 |

**回滚策略**：每个阶段用 feature flag（`KCODE_*` env 或配置）包住行为变更；发布前跑 `--safe-mode`（禁用 hooks/skills/MCP）复现基线；保留上一版可执行文件。

---

## 8. 明确不做（阶段一~三）

- 阶段一~三不并行铺 desktop 新功能；桌面按 [desktop-plan-2026-10.md](./desktop-plan-2026-10.md) 的 D0–D4 独立推进，共享内核修复优先，不把 CLI 的问题带到另一个壳。
- 不做插件市场/签名（阶段四再评估）。
- 不做 i18n/遥测/computer-use/语音。
- 不做自研渲染器/OpenTUI。
- 不追 ZCode 的全量工具清单；只补"日常闭环"缺的。
- 不做自定义键位系统（先修好默认键位）。
- 不做金额成本估算（BYOK 价格不可知；只做 token 分项）。

---

## 9. 文档与流程

1. **DESIGN 三态化**：每个条目 `[实现]` / `[部分]` / `[目标]`；`[实现]` 必须附测试文件或入口路径。
2. **变更模板**：行为改动必须写"场景 → 状态所有者 → 接口 → 验收测试"四段。
3. **发布门禁**：阶段一/二出口标准未过，不发 0.3；阶段三未过，不发 0.4。
4. **每周对账**：用 `docs/cli-gap-analysis-2026-10.md` 的 P0/P1 清单勾选，禁止"口头完成"。
5. **事故复盘**：任何数据丢失/权限误放行，24h 内补回归测试，再修。

---

## 10. 一页执行清单

### 阶段一（本周就开工）

- [ ] 1-01 resume 透传 sessionId
- [ ] 1-02 resume 二次续接测试
- [ ] 1-03 摘要失败抛错
- [ ] 1-04 压缩熔断机械兜底
- [ ] 1-05 工具失败原因回灌
- [ ] 1-06 capToolResult 按 token
- [ ] 1-07 统一内部 cap
- [ ] 1-08 edit EOL 归一
- [ ] 1-09 isWithinWorkspace
- [ ] 1-10 预算计 args/images
- [ ] 1-11 Windows CI

### 阶段二（阶段一出口后）

- [ ] 2-01 `kcode login/init` + unconfigured TUI
- [ ] 2-02 LLM 延迟解析
- [ ] 2-03 `/login` 合并配置
- [ ] 2-04 `--help`
- [ ] 2-05 fatal 可交互
- [ ] 2-07 `-p` 恒无头
- [ ] 2-08 stdin
- [ ] 2-09 `--mode` 交互
- [ ] 2-10 `--disallowed-tools` 透传
- [ ] 2-11 退出码契约
- [ ] 2-13 env 清洗
- [ ] 2-14 敏感路径
- [ ] 2-15 SSRF 逐跳
- [ ] 2-16 hook 后复核
- [ ] 2-17 项目扩展 trust
- [ ] 2-20 审批完整信息
- [ ] 2-21 参数级会话放行
- [ ] 2-23 模式同步
- [ ] 2-24 help 生成化

### 阶段三（阶段二出口后）

- [ ] 3-01 resume 转写
- [ ] 3-03 关闭/退出清理
- [ ] 3-07 apply_patch
- [ ] 3-08 replaceAll
- [ ] 3-09 读后校验
- [ ] 3-10 bash 体验
- [ ] 3-14 MCP 能力
- [ ] 3-15 hooks matcher
- [ ] 3-20 模型超时/溢出
- [ ] 3-22 长输出
- [ ] 3-23 diff 审查
- [ ] 3-25 Static 修复
- [ ] 3-26 终端安全
- [ ] 3-31 文档对账

### 阶段四（看 0.4 数据再定）

- [ ] 4-01 Windows 沙箱
- [ ] 4-02 策略文件
- [ ] 4-03 LSP
- [ ] 4-05 fork/命名/搜索
- [ ] 4-07 auto memory

---

## 附：与诊断文档的对应关系

| 诊断项 | 优化项 |
|---|---|
| P0-1 resume 丢历史 | 1-01/1-02 |
| P0-2 压缩吞历史 | 1-03/1-04 |
| P0-3 错误码丢失 | 1-05 |
| P0-4 预算失真 | 1-06/1-07/1-10 |
| P0-5 CRLF/跨盘 | 1-08/1-09 |
| P0-6 脚本化 | 2-07~2-12 |
| P0-7 安全三连 | 2-13~2-19 |
| P0-8 审批知情同意 | 2-20/2-21 |
| P0-9 模式脱节 | 2-23 |
| P1 会话/工具/扩展/TUI | 阶段三对应项 |
| 能力缺口（LSP/fork/沙箱） | 阶段四 |

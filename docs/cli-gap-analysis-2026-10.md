# kcode CLI 现状诊断与差距分析（2026-10-19）

> 范围：`apps/cli` + `packages/*` 的终端形态。**本文是 2026-10-19 的 CLI 快照，不含 desktop / web / marketplace**；桌面端随后纳入，见 [desktop-plan-2026-10.md](./desktop-plan-2026-10.md)。
> 方法：逐文件静态审计 + 与 DESIGN.md / README 对账；本机 shell 环境不可用（pwsh 0xC0000142），未运行测试，运行时相关项标「待验证」。
> 对标基线见 [cli-agent-benchmark-2026.md](./cli-agent-benchmark-2026.md)（46 项 checklist）。

---

## 0. 一页结论

**里子比壳子好。** Agent 循环、JSONL 可回放会话、key 受众绑定、权限分层、压缩锚点、子代理、中文 TUI、110 个测试文件——这些是真实资产，部分设计（受众绑定、DPAPI、plan 只读档）比主流产品更严谨。

**但它现在还不是一个"可交付日常使用"的 CLI**，而是一个"功能面很宽、最后一公里没走完"的 0.2 内测版。最伤的六件事：

1. **首次运行走不通**：没有 `~/.kcode/config.json` 就抛错退出，而唯一的自助配置入口 `/login` 在 TUI 里——鸡生蛋。
2. **resume 名不副实**：CLI 续接时新建了会话文件、却没把种子历史写进去（也没传原 sessionId），第二次 `-c` 会静默丢掉之前的对话。host 端已经传了，CLI 漏了。
3. **压缩失败会吞历史**：摘要模型返回鉴权错/限流错时，`summarizer` 把失败当空摘要，`loop` 当成压缩成功，整段历史被一行占位文案替换且不可逆。
4. **工具结果失真**：失败工具只回灌 output、丢掉 `exit code`；`capToolResult` 把 8192 token 预算换算成 1.3 万字符，read 宣称 2000 行实际只给约 300 行，且不告诉模型缺哪些行。
5. **Windows 基础编辑不可靠**：CRLF 文件上 `edit` 的精确匹配恒失效，全部落到同步模糊匹配；跨盘写入绕过工作区边界。
6. **脚本化契约不成立**：`-p` 在 TTY 进 TUI、没有 `--help`、管道 stdin 被静默忽略、`--disallowed-tools` 在交互态静默失效。

**三个结构性不合理**（比单个 bug 更值得先决策）：

- **文档领先实现**：DESIGN 大量「已落地 / 已收口」与代码不符（hooks matcher、审计、60% 文案、工具缺口、TUI 完成度）。项目自己的纪律 §6.3.7「文档不夸大」被违反，会持续制造错误判断。
- **安全模型靠"确认"而不是"隔离"**：无 OS 沙箱、权限判定在 hook 之前（hook 可在批准后改参）、`KCODE_KEYCHAIN_PASSPHRASE` 被 bash 子进程继承、读工具无路径边界、web_fetch 重定向不复检。提示注入在这个组合下不是理论风险。
- **功能广度挤压基础正确性**：13 个工具、21 个命令、6 类扩展、MCP/插件/子代理/Web 都在铺，但"读大文件、改 CRLF 文件、跑测试看失败"这三条日常主链路都有 correctness bug。

---

## 1. 现状盘点（以代码为准）

### 1.1 已经具备的

| 域 | 事实 |
|---|---|
| 入口 | TUI（Ink）、`-p` 一次性、`--json` NDJSON、`--resume/-c`、`--image`、`--cwd`、`--model`、`--disallowed-tools`（仅 headless）、子命令 `key/plugin/mcp/doctor/skills/commands/update` |
| 会话 | JSONL append-only、`session_start/user_message/assistant_message/tool_call/tool_result/...` 19 类事件、`/rewind` 文件+对话、`/compact`、`/context`、`/cost`、`/export` |
| 工具 | read/glob/grep/extract/write/edit/bash/todo/ask_user/task/task_output/task_stop/sessions/skill/plan_submit/send_message/respond_to_coordinator + MCP + web_search/web_fetch（共 13 个内置 + 会话工具） |
| 权限 | 四档（plan/default/acceptEdits/fullAccess）、项目级持久放行、参数级 bash/edit/write 规则、`/permissions`、automation 降级 |
| 扩展 | SKILL.md 渐进加载、`.kcode/commands`、hooks 六事件、插件装卸+seed 校验、`.kcode/agents` 子代理、MCP stdio/http/sse |
| 上下文 | AGENTS.md（cwd + home）、技能元数据、工具描述、三层压缩（回灌截断 / 超预算摘要 / 手动）、provider usage 校准、计划锚点 |
| 模型 | OpenAI 兼容（DeepSeek/GLM/Kimi/Ollama/中转）、listModels、reasoning_content、清洁重试、DPAPI/口令 keychain、受众绑定 |
| 交互 | 流式、Markdown+高亮、工具卡、Ctrl+B/T/O/E/V/R、Shift+Tab、Tab 补全、@ 文件、`#` 记忆、双击 Esc rewind、状态栏 |
| 工程 | 110 个测试文件、typecheck/lint/depcruise/knip/gates、replay eval、mini-shop 10 任务、tsup 发行链 |

### 1.2 真正的亮点（不要在重构中丢掉）

- **key 受众绑定**：key 只发往登记端点，改 baseURL 即硬失败。同类产品少见。
- **Windows DPAPI 免口令**：新用户不必理解"口令环境变量"。
- **JSONL + replay**：事件流即账本，天然可做 eval / 审计 / 回放。
- **plan 档不可穿透**：持久放行打不穿只读档。
- **压缩锚点**：首问 + 已批准计划跨压缩保真。
- **子代理异步化**：后台运行、完成通知、子会话独立落盘、fan-out 并行组。
- **中文优先的 TUI**：CJK 宽度、IME 重绘、中文菜单这些细节做了。

### 1.3 成熟度判断

- **引擎层**：B+。结构清晰、端口注入、测试覆盖好。
- **工具层**：C。能力齐但 correctness/预算/边界问题多。
- **入口层**：C-。缺首用、脚本化契约、错误出口。
- **交互层**：B-。高频键位和视觉做了，但详情/长输出/diff/一致性欠账。
- **安全层**：C。设计文档强，落地边界弱（无沙箱、审批顺序、凭据暴露）。
- **工程层**：B。门禁齐，但 CI 只在 Ubuntu，Windows 主平台无回归。

---

## 2. 与 2026 主流 CLI 的差距（精简版）

> 完整 46 项见 [cli-agent-benchmark-2026.md](./cli-agent-benchmark-2026.md) §11。✅ 有 / ⚠️ 弱 / ❌ 无。

| 维度 | 2026 基线 | kcode | 差距 | 优先 |
|---|---|---|---|---|
| 首用/登录 | 开箱登录（OAuth 或 API key 向导） | ❌ 必须手写 config.json；`/login` 进不去 | 高 | P0 |
| 无头契约 | `-p` 即无头 + JSONL/stream-json + 语义退出码 + schema | ⚠️ `-p` 在 TTY 进 TUI；只有 NDJSON；0/1/130 | 高 | P0 |
| 脚本输入 | stdin 管道 / heredoc | ❌ 管道内容被忽略 | 高 | P0 |
| 配置层级 | user/project/local/flag/env + settings 文件 | ⚠️ 用户级 JSON + 项目 default + 少量 env | 高 | P1 |
| 沙箱 | OS 级隔离（含 Windows） | ❌ 只有交互确认 | 高 | P1 |
| 权限规则 | allow/ask/deny + 参数级 + 策略文件 | ⚠️ 有参数级 allow，无 deny 策略文件 | 高 | P1 |
| 会话回滚 | checkpoint/rewind + 文件级 undo + fork | ⚠️ rewind 只有"文件+对话"；无 fork；检查点仅 write/edit | 高 | P1 |
| 会话管理 | 命名/搜索/删除/导出/恢复 | ⚠️ 只有 id + 首问预览；导出走 UI 块（截断） | 中 | P1 |
| 上下文记忆 | AGENTS.md 三级 + 子目录按需 + auto memory | ⚠️ 只有 cwd + home；无子目录；无 auto memory | 中 | P1 |
| 工具正确性 | 读全/改准/跑测试可见失败 | ⚠️ 错误码丢失、CRLF edit、预算失真 | 高 | P0 |
| 代码理解 | LSP/diagnostics/repo map | ❌ | 中 | P2 |
| 扩展标准 | 命令 frontmatter、skills allowed-tools、hooks matcher、MCP OAuth | ⚠️ 均为简化版 | 中 | P1 |
| 交互 | 命令面板/主题/vim/消息级编辑/长输出查看/diff | ⚠️ 部分；无 diff 审查、无长输出、无主题 | 中 | P2 |
| Windows | 原生可用 + 原生沙箱 | ⚠️ 可用但依赖 git-bash/PowerShell，无沙箱；CI 不测 Windows | 高 | P1 |
| 可观测性 | `/usage`、debug、trace、审计 | ⚠️ `/cost` 只有 token；审计在内存 | 中 | P2 |

**一句话**：kcode 的"有/无"清单已经接近主流，但每一项的**语义完整度**普遍低一档——这正是"看起来什么都有、用起来处处不对劲"的来源。

---

## 3. P0：先修这 8 件（1–2 周）

### P0-1 resume 语义断裂：二次续接丢历史

- 证据：`apps/cli/src/session.ts:142-161` 只把 `resume.messages/usage` 传给 `composeSession`，**没有传 `sessionId`**；`packages/session/src/composition.ts:140-141` 于是 `newId("sess")` 新建 JSONL；`loop.ts:282-293` 的 `session_start` 也不携带种子历史。对照 `apps/host/src/session.ts:60-83`——host 路径显式 `targetSessionId` 并 `sessionId: targetSessionId`，注释写着"续接继承原会话 ID"。
- 影响：`kcode --resume X` 或 `/resume` 实际生成新会话 Y，Y 的文件里只有新事件，X 的历史只在进程内存。再 `-c`/`--resume latest` 会选中 Y（mtime 最新），**X 的整段对话消失**，且无告警。`/cost` 的续接用量、checkpoint 目录、rewind 列表也全部按 Y 重建。
- 修法：`resolveResumeHistory` 返回 `sessionId`（从文件名取）→ `createSession` 透传；若产品上要 fork，则必须落 `parentSessionId` 并把种子历史写成事件/引用，不能"叫 resume 实为匿名 fork"。
- 回归测试：resume 两次（A→B→B）后历史仍包含 A 的全部消息。

### P0-2 压缩失败被当成成功，历史不可逆丢失

- 证据：`packages/platform/src/providers/summarizer.ts:31-45` 只累加 `text`，忽略 `end.reason === "error"`；`openai-compatible.ts:165-170` 的不可重试错误（401/400/模型不存在）正是以 `end/error` 收尾而不抛；`compact.ts:115-120` 无条件应用；`loop.ts:263-269` 把 `result !== null` 当成功并清零熔断计数。
- 影响：鉴权过期、模型名错、限流耗尽时，自动压缩"成功"——`toSummarize` 永久消失，只剩一行占位。压缩在每个模型步开头跑，错误配置下会连续丢历史。
- 修法：`summarize` 失败必须抛；`runCompaction` 仅在摘要非空且长度合理时应用；失败走 `compactFailures++`（现有熔断即可生效）；熔断后降级为"机械截断 + UI 明示"。

### P0-3 工具失败原因不回灌，模型把失败当成功

- 证据：`packages/core/src/core/settle-results.ts:38-44` 的 `result.output !== "" ? result.output : (result.error ?? "")`；`bash.ts:201-204` 失败时 `{ok:false, output:text, error:"exit code N"}`；`replayer.ts:139-144` 同款。
- 影响：`npm test` 失败但有 stdout → 历史里只有 stdout，"exit code 1" 永远不可见。模型据此认为通过、继续下一步。现有测试只覆盖了 output 为空的 `exit 3` 分支。
- 修法：回灌内容改为 `ok===false ? "[失败: ${error}]\n${output}" : output`；`ToolOutput` 增加结构化 `meta.exitCode/truncated/artifactPath`，由 loop 统一渲染。

### P0-4 工具结果预算失真：read 宣称 2000 行，实际约 300 行

- 证据：`packages/core/src/context/budget.ts:75-84` 的 `maxChars = toolResultBudget * 1.6`；`packages/shared/src/index.ts:29-40` 西文估算约 3.8 字符/token。8192 预算 → 13107 字符 → ASCII 约 3449 token（只用 42%），CJK 约 9830 token（超 20%）。
- 影响：read 默认 2000 行（约 6–8 万字符）实际只回灌约 1.1 万字符（≈300 行），但头部仍写"共 N 行，显示 1-2000"；web_fetch 的 40k、extract 的 60k、grep 的 64k、bash 的 30k 同理。截断注记只说"原文 N 字符"，不告诉 read 缺哪些行、不给续读方法 → 模型无法自纠。
- 修法：`capToolResult` 按 `estimateTokens` 二分前缀/后缀；read 降低默认 limit 或输出"已显示 1-350 / 共 N 行，用 offset=351 继续"；统一工具内部 cap 与 `resultBudget`（否则内部 cap 是死代码）。

### P0-5 Windows 编辑与边界：CRLF + 跨盘

- CRLF：`read.ts:59-70` 按 `\r?\n` 切、用 `\n` 拼回，模型看到的文本永不含 `\r`；`edit.ts:63` 却对磁盘原始内容做精确匹配 → CRLF 文件精确匹配恒为 0，全部落入 `fuzzyReplace`（同步 Levenshtein，上限 2 万窗口，阻塞事件循环；超过窗口的文件后半段永远改不了；混合 EOL 被整篇改写）。
- 跨盘：`write.ts:16-25`、`edit.ts:49-54` 用 `rel.split(sep)[0] === ".."` 判越界；`path.win32.relative("E:\\ws","D:\\x")` 返回绝对路径，首段是 `D:` → 判定"在工作区内"直接放行。`bash.ts:213-217` 的 `isWithinPath` 用了 `isAbsolute(rel)`，反而是对的。
- 附带：`write` 对工作区外路径直接 `ok:false`，但注释说"由权限 ask 兜底"；用户批准后仍被拒，fullAccess 也写不了。没有 `--add-dir`，monorepo 跨包编辑基本不可用。
- 修法：统一 `isWithinWorkspace(cwd, abs)`（`relative` + `isAbsolute` + `..` 前缀）供 write/edit/bash 复用；edit 先把 content 与 oldString 归一到 `\n` 再精确匹配（记录原 EOL 还原）；模糊扫描让出事件循环并改为时间预算；越界策略上移到权限引擎（越界 → ask，而不是工具内 deny）。

### P0-6 脚本化契约：`-p`/`--help`/stdin/`--mode`/`--disallowed-tools`

- `main.tsx:274` 用 `args.json || (oneShot !== undefined && process.stdin.isTTY !== true)` 判 headless。结果：`kcode -p "x" | jq`（stdin 是 TTY、stdout 是管道）会进 Ink，把 ANSI 帧写进管道；`script`/`docker -t`/tmux 下同理。
- `main.tsx:292-295` 在交互态直接拒绝 `--mode`，与 usage「初始权限档」矛盾；`--disallowed-tools` 只传 headless，TUI 静默忽略。
- `args.ts:135-139` 没有 `--help/-h`：`kcode --help` 报"未知参数"并打整段 stack；`kcode help` 被当提示词发给模型。
- stdin 管道内容**从未被读取**（`headless.ts` 无 stdin 逻辑）：`cat log.txt | kcode -p "explain"` 静默丢输入。
- 退出码只有 0/1/130；headless 写类 ask→deny 但仍可能 `completed` → CI 假绿。
- 修法：有 `-p` 即 headless（另设 `--interactive`）；`--help/--version` 在一切 IO 之前；读取 stdin 并在 prompt 前后拼接；`--mode` 交互态允许（fullAccess 二次确认）；`--disallowed-tools` 透传 TUI；headless result 增 `permissionDenials/toolFailures/usage`，有 deny 且 completed 时改状态/退出码。

### P0-7 安全三连：凭据进环境、读无边界、SSRF 只查首跳

- **凭据**：`main.tsx:245` 把口令写进 `process.env.KCODE_KEYCHAIN_PASSPHRASE`；`bash.ts:298` 的 `spawn` 不筛 env；`safe-commands.ts:14` 把 `echo/printf/cat` 列为免确认安全命令。组合结果：提示注入一句 `echo $KCODE_KEYCHAIN_PASSPHRASE` 即可让模型读到口令，再 `cat ~/.kcode/keys.json` 读密文 → 离线解密。
- **读边界**：`read.ts:38`、`grep.ts:47`、`glob.ts:39`、`extract.ts:55` 接受任意绝对路径且 `permission.default:"allow"`；没有 `.env/.ssh/.aws/.git-credentials` denylist。`web_fetch` 抓到恶意页面后可指示模型读本机文件再外发。
- **SSRF**：`web.ts:98-101` `redirect:"follow"`，`isPrivateHost` 只校验初始 URL（`:175`），`finalUrl` 只用于展示；公网 302 → `127.0.0.1`/`169.254.169.254` 即绕过。`isPrivateHost` 还漏 IPv6 ULA/link-local、`0.0.0.0`、整型 IPv4。
- **审批顺序**：`pipeline.ts:77-135` 是"权限裁决 → hooks 改参 → 执行"。hook 可在用户批准后把 `ls` 改成 `rm -rf`，权限不复核（TOCTOU）。
- 修法（按性价比）：spawn 前剥掉 `KCODE_*` 与常见 secret env；read 增加敏感路径 denylist + 工作区外提示；`redirect:"manual"` 逐跳校验（含 DNS 解析后 IP）；hook mutate 后重新走权限判定；`--` 或隐藏输入录入 key，避免 argv。

### P0-8 审批面板不足以支撑"知情同意"

- 证据：`panels.tsx:34` 只显示 `JSON.stringify(args).slice(0, 80)`，bash 没有 diff 预览（`ask-preview.ts:60` 直接返回 undefined）；edit/write 的 diff 只显示 20 行（`DiffPreview.tsx:7`），底层已先截 40 行；`OptionsMenu` 默认高亮第 0 项（"允许"），回车即放行；"允许，本会话不再询问"实际是**整工具**放行（`panels.tsx:42` + `composition.ts:179-181` + `engine.ts:69-73`）。
- 影响：`npm test && rm -rf build` 只能看到前 80 字符；写 50 行文件只看到前 20 行；习惯性回车直接允许；用户以为"本会话不再问这个命令"，实际所有 bash 都不再问。
- 修法：完整命令/diff + 滚动/分页；默认高亮改"拒绝"或必须显式选择；会话级放行也走 `suggestGrant` 参数级；选项行显示真实快捷键（`y/s/p/n` 与 footer 的"数字"不一致）。

### P0-9 切换会话后权限档位与 UI 脱节

- 证据：`composition.ts:413-415` 只有传 `initialMode` 才 `applyMode`；`/clear`（`commands.ts:300-312`）和 `/resume`（`lifecycle.ts:159-183`）新建会话时都不传，引擎回到 `default`；但 React 的 `mode` state 不变，状态栏仍显示旧档位。
- 影响：用户在 **plan（只读）** 下 `/clear` 或 `/resume`，UI 仍显示"⏸ 只读"，引擎已是 default（写操作变成"询问后允许"）。这是安全相关的静默降档。
- 修法：`createSession` 调用点统一传 `initialMode: mode`；或在 switchSession 后 `applyMode(mode)`；加回归测试。

---

## 4. P1：日常可用的欠账（2–4 周）

### 4.1 会话/持久化

| 问题 | 证据 | 影响 |
|---|---|---|
| **resume 不重放转写** | `lifecycle.ts:51-124` 只推 banner；`switchSession` `resetTranscript()` 后只推一条 info（`lifecycle.ts:184-190`） | `kcode --resume X` / `/resume` 后屏幕是空的，看不到之前任何对话；引擎有历史但用户无从确认 |
| 图片输入不落盘 | `contracts/session.ts:21-27` 的 `user_message` 无 `images`；`loop.ts:338-368` 只写 content | resume / rewind 后图片上下文丢失，模型看不到之前发的图 |
| `/resume` 列表跨项目且按目录名字典序切片 | `runtime/session/resume.ts:57-62` 按 workspaceKey 排序；`apps/cli/src/session.ts:249-252` 再 `slice(0,10)` | 多项目下当前项目的最近会话可能根本不在菜单里 |
| 切换会话不关闭旧会话 | `commands.ts:300-312`、`lifecycle.ts:146-201` 未 `close()` 旧 handle | MCP 子进程、后台 bash、子代理泄漏；旧会话事件可能串进新转写 |
| 退出不清理 | `App.tsx:322-323,375` 直接 `exit()`；全仓仅 headless 调 `close()`；无 SIGINT/SIGTERM handler | MCP/后台任务孤儿；`session_end`/usage 丢失 |
| 检查点无上限、二进制不安全、静默跳过 | `checkpoints.ts:67-79` 每次整文件 copy；`:91-110` utf8 往返 + 失败 `continue` 不计数 | 大文件多次编辑磁盘膨胀；二进制回滚损坏；"已恢复 3 个"可能实际只恢复 2 个 |
| 子代理改动不在 rewind 范围 | `composition.ts:285-296` 子代理共用 checkpoint store；`rewind.ts:35-42` 只从父事件收集 callId | `/rewind` 报告"已恢复"但子代理写的文件原样留下——半回滚比不回滚更危险 |
| 导出是"视图导出"不是"会话导出" | `commands.ts:412-430` 用 `ui.blocks`；`events.ts:77` 工具输出截断 2000 字符 | `/export` 丢全文、丢被折叠内容，不能作为交付物 |
| 无保留/删除策略 | 全仓无 cleanup 调用；`~/.kcode/cli/sessions|artifacts|checkpoints` 只增 | 长期使用磁盘线性增长；无 `kcode sessions rm` |
| JSONL 无 fsync/无队列/无迁移 | `jsonl.ts:16-18` 逐条 `appendFile`；`contracts/session.ts:4` 只有 `v:1` 字面量 | 崩溃丢尾部；并发 resume 可能交错；未来 v2 被旧版当坏行 |

### 4.2 工具面

| 问题 | 证据 | 影响 |
|---|---|---|
| 大输出 artifact 路径被截掉 | `output-collector.ts:93-99` 把路径放在 28k 处；`bash resultBudget:4096` 只保留约 6.5k 字符 | 模型拿不到完整日志路径，落盘白做 |
| 超时/中断丢已产生输出 | `bash.ts:313-316` reject；`:205-206` catch 返回 `output:""` | `npm run build` 超时后模型看不到任何编译错误 |
| 超时只 race 不 abort | `pipeline.ts:146-161` | 超时工具继续写工作区，与下一轮并发 |
| 进程树清理不一致 | `bash.ts:281-285` 前台 win32 用 `taskkill /T`，POSIX 只 kill shell；`registry.stop` 只 `child.kill()` | 孤儿进程；CLI 退出后 dev server 常驻 |
| grep `maxResults` 是每文件 | `grep.ts:49-56` 用 rg `--max-count` | 200 个文件各 200 行；无上下文/多行/type/files-only/分页 |
| glob 不认 .gitignore、按字典序 | `glob.ts:43-52` | 与 grep 结果不一致；dist/target 噪声；不按最近修改排序 |
| CRLF 精确编辑失效 | 见 P0-5 | Windows 仓库每次编辑都走模糊 |
| 无 replace_all / apply_patch / 读后校验 | 全仓无实现 | 多文件重构只能逐个文件；模型可基于陈旧内容覆盖 |
| XLSX 公式/超链接/错误值 → `[object Object]`；日期 UTC 早一天 | `extract.ts:223-232` | 读表格核心内容不可用 |
| PDF 无 OCR/版面；扫描件静默空白 | `extract.ts:165-181` | 读扫描件得到空文本却 `ok:true` |
| todo 对模型"只写不读" | `replayer.ts:101` 跳过 `todo_update`；无 system-reminder 回注 | resume/压缩后模型忘记清单；长任务重复建单 |
| task 看门狗会误杀长命令 | `subagent.ts:205-219` 只被 sink 事件喂；子代理无 onDelta | 120s 纯流/长 bash 被 abort |
| task_output 整文件读入、无 list/wait | `task-tools.ts:27,54` | 长日志 OOM；压缩后 taskId 丢失无法找回 |
| MCP 工具一律 readOnly:false、忽略 annotations | `mcp/provider.ts:89` | plan 档全拒；default 每次 ask |
| MCP callTool 不接 signal | `mcp/provider.ts:93` | Esc 不能取消挂起的 MCP 调用（等 60s） |
| MCP 只取 text 块 | `mcp/provider.ts:101-104` | 图片/结构化内容/资源全丢 |

### 4.3 入口/扩展/模型

| 问题 | 证据 | 影响 |
|---|---|---|
| `/login` 覆盖整个 providers + 丢 budget | `LoginWizardPanel.tsx:157-169` → `saveUserModelsConfig` 只写 `{models}` | 加第二个厂商会清掉第一个；需要重启才生效 |
| 插件 hooks/permissions 从不生效 | `composition.ts:237-245` 只消费 `manifest.mcp`；`install.ts:85-105` 只打印 | 同意摘要宣称会跑 hooks/申请权限，实际全不执行 |
| 插件 http MCP 被当 `node <url>` | `composition.ts:237-245` 强制 `stdio` + `command:"node"` | 声明 http 的插件 MCP 必然启动失败 |
| 插件安装不询问 | `main.tsx:73-78` 打印摘要后直接装 | 供应链确认形同虚设 |
| 更新链接受 http、无签名、无解包校验、无回滚 | `update.ts:50-55,116-156` | `KCODE_UPDATE_URL` 被污染即任意代码执行；升级失败无法回退 |
| hooks 无 matcher、协议不兼容、`.strict()` 一错废全文件 | `contracts/hooks.ts:23-48`；`runner.ts:109` | 每个工具都跑所有 hook；CC 风格 JSON 被丢弃；配置里多一个键整文件失效 |
| 命令无 frontmatter/`!bash`/命名空间 | `commands/index.ts:56-66` | 按 CC 习惯写的 `---` 头会被当正文发给模型 |
| skills 缺 `allowed-tools`/`disable-model-invocation`，手写 YAML | `contracts/skill.ts:4-9`；`skills/parse.ts` | 第三方技能无法声明工具白名单；来源策略未落地 |
| subagent 只有 tools/model，无 permissionMode/plugin 源 | `contracts/agent.ts:8-14`；`composition.ts:193-199` | 只读 agent 无法声明只读；插件不能带 agent |
| 无项目级 MCP | `composition-helpers.ts:11-19` 只读 `~/.kcode/mcp.json` | 团队无法在仓库里共享 MCP 配置 |
| MCP 无 headers/OAuth，未知键被静默 strip | `contracts/mcp.ts:9-27`；`provider.ts:40-52` | 需要 token 的远端 MCP 不可用 |
| 只有 OpenAI 兼容；modelRef 禁 `:` 和嵌套 `/`；keyRef 仅 keychain:// | `contracts/provider.ts:13-35` | Ollama tag、OpenRouter 多级模型名、CI env key 全不支持 |
| 无 headers/代理/请求超时/温度等参数 | `route.ts:32-49`；`openai-compatible.ts:68-98` | 企业代理不可用；断网可无限挂起 |
| 上下文窗口表只有 5 族 | `core/context/budget.ts:17-34` | GPT/Claude/Gemini 回退 128k，提前压缩或溢出 |
| 会话级放行是整工具 | `engine.ts:61-63`；`panels.tsx:41` | 允许一次 `bash ls` = 本会话所有 bash 免确认 |
| 无 deny 规则文件 | 只有 mode + allow grants | 无法声明"永不执行 rm -rf / del /s / git push --force" |

### 4.4 交互

| 问题 | 证据 | 影响 |
|---|---|---|
| Shift+Tab 双处理器 | `keybinds.ts:30-39` 与 `98-107` 同时注册 | 空闲时每次切档打印两遍"已切换"并两次 setMode；忙时第一个（无 busy 守卫）仍会切档 |
| `/help` 过期且不全 | `commands.ts:504-522` 写 `/ctx.mode`、漏 `/hooks` `/export`；banner 说"/help 全部键位"但实际没有键位表 | 新用户按帮助操作会失败 |
| `/compact` 文案写"超预算 60%" | `commands.ts:456` | 与实际 73%（128k）不符 |
| `exit` 在 busy 时直接退出 | `App.tsx:322-325` 的 exit 判断在 busy 判断之前 | 运行中误输入 exit 会直接杀进程，丢 session_end/子进程 |
| 致命错误 80ms 后退出 | `lifecycle.ts:125-136` `setFatal` 后 `setTimeout(exit,80)` | 用户可能只看到闪一下；管道里完全丢失 |
| **运行中的工具卡会被推进 Static 卡死** | `TranscriptView.tsx:17-32` 只把"块尾连续 running"放活区；运行中一旦推入排队 info / Shift+Tab 提示 / `subagent_spawned`，工具块就不再位于尾部 → 进入 Static 定格为 ⚡；之后 `settleTool` 改数组也不会重绘 | 任务卡永久显示"进行中"，完成/失败状态丢失（长任务/子代理场景高频） |
| Ctrl+O 对已打印块无效 | `TranscriptView.tsx:30-35` 用 Ink `<Static>`；Static 不重渲染旧项 | 想展开历史思考/工具输出时"按了没反应" |
| 工具输出 UI 截断 2000 字符 / 12 行 | `events.ts:77`；`Transcript.tsx:76-79,224-235` | 长输出在 TUI 里永远看不到全文 |
| 无 diff 审查 | 工具卡只显示路径；`DiffPreview` 仅审批时 20 行 | 用户无法在写完后再看改了什么 |
| write 大文件 diff 退化 | `ask-preview.ts:71-77` 超 80 行直接"全删+全增"再截 40 行 | 确认 500 行文件写入时只看到前 40 行删除 |
| 审批 bash 显示 JSON | `panels.tsx:34` `JSON.stringify(args).slice(0,80)` | 用户看不到完整命令尾部（危险参数可能被截掉） |
| 无 Ctrl+A/E/U/K/W / 词移动 | `InputBox.tsx:253-255` 所有 ctrl 提前 return | 长提示词编辑只能逐字退格；Home/End 靠 stdin tee 补丁 |
| `#` 前缀劫持任意输入 | `InputArea.tsx:128-150` 任何以 `#` 开头的提交都写 AGENTS.md 并清空输入 | 问 `#include`、`#123 issue` 会被当"记忆"写入；无确认、不进模型 |
| 附件在斜杠路径静默丢失 | `App.tsx:335-337` 先 `clearPendingImages()` 再 dispatch；`commands.ts:542-544` 斜杠分支不消费 images | 贴图后执行 `/model` 等命令，图片消失；排队消息也不带图 |
| Ctrl+C 在 abortSent 后不再响应 | `keybinds.ts:112-124`、`App.tsx:169-175` | LLM 流挂死（无请求超时）时无法从键盘强退，只能杀终端 |
| Ctrl+J 换行不可发现 | `InputBox.tsx:369-376`；`/help`/ghost 未提；Shift+Enter 仅部分终端可区分 | 新用户以为只能单行输入 |
| 终端转义未清洗 | `Transcript.tsx:224-242` 直接把工具/助手输出交给 `<Text>`；`markdown.tsx` 无 ESC/OSC 过滤 | 恶意仓库输出可改标题、写剪贴板（OSC 52）、伪造链接、清屏；至少显示错乱 |
| 后台任务不可见 | 唯一入口 Ctrl+T（`keybinds.ts:164`）；状态栏无 running 计数；bash 完成只走 `onNotice`（`bash.ts:162`），单槽会被覆盖；铃声只在子代理路径（`events.ts:44`） | 切走后不知道任务完成/还有几个在跑；UI 不能 stop |
| 审批/提问出现无提醒 | `notify.ts:37-54` 只在 busy 下降沿且本轮 ≥10s 响铃；`interactions.ts` 打开 ask 时无铃声/标题变化 | agent 等待批准时用户可能不在，运行无限暂停 |
| 未知 `/` 命令清空原文 | `commands.ts:100-105` 先清输入；`/Users/...`、正则 `/foo/` 无法原样发送 | 输入丢失；文件路径无法直接提问 |
| 主题固定暗色 hex、无 NO_COLOR/plain 模式 | `design/terminal.ts:8-24`；`TERMINAL_SYMBOLS` 定义了但 CLI 未用 | 亮色终端对比度差；旧 conhost/屏幕阅读器无 ASCII 降级；无法切换主题 |
| 无命令面板/主题/vim/`/todos`/`/config`/`/init`/`/memory` | 命令表 19 项 | 可发现性与配置能力弱 |
| `/model` 切换后可用模型清单仍查旧 provider | `session.ts:229-246` 用 `opts.model` 闭包 | 二次打开菜单可能列出旧端点模型 |

---

## 5. 能力缺口：真的缺 vs 可以凑合

| 能力 | 判定 | 说明 |
|---|---|---|
| 多文件 `apply_patch` / 多组编辑 / `replace_all` | 真缺 | bash 替代会绕过 checkpoint/diff/权限 |
| 读后过期校验（mtime/hash） | 真缺 | 可防止覆盖用户改动 |
| `--add-dir` / 多工作区 | 真缺 | 工作区外写入被硬拒；monorepo 跨包不可用 |
| OS 沙箱（Windows restricted token + job object） | 真缺 | 当前只有交互确认；这是"敢不敢跑"的门槛 |
| 网络白名单 / 策略文件 | 真缺 | 无 |
| LSP / diagnostics / 定义跳转 | 真缺 | 只能跑 `tsc` 全量 |
| repo map / 语义搜索 | 真缺 | 只有 rg 关键词 |
| PDF OCR / 版面；PPTX/CSV | 真缺 | 读文档场景核心缺口 |
| 会话 fork / 命名 / 搜索 / 删除 | 真缺 | 只有 id + rewind |
| 消息级编辑/重发 | 真缺 | 只有轮级 rewind |
| 自动记忆（auto memory） | 真缺 | 只有静态 AGENTS.md |
| shell stdin/PTY 交互 | 真缺 | 交互式命令会挂到超时 |
| MCP resources/prompts/OAuth | 真缺 | 只有 tools + text |
| 主题/vim/命令面板/statusline 脚本 | 真缺（体验向） | 有替代但不完整 |
| 费用统计（货币） | 真缺 | 只有 token；BYOK 价格未知，可不做 |
| git 结构化 diff/commit | 可凑合 | `git status/diff/log` 在安全白名单；但没有自动提交/交付闭环 |
| 目录树/ls | 可凑合 | `ls/tree/find` 可用，但工具描述没引导 |
| grep 上下文/type/files-only | 可凑合 | `rg -C -t -l` 可用，但模型不知道 |
| 会话分享/云 | 超出 CLI 范围 | 不做 |

---

## 6. 不合理之处（设计/流程，而非单点 bug）

### 6.1 文档领先实现，是当前最大的"认知风险"

DESIGN.md 把大量"有文件/有 schema/有接口"写成"已落地"，而代码事实是半成品：

| DESIGN 声明 | 代码事实 |
|---|---|
| §2.1「审计」/ §7「审计留痕」 | `composition.ts:345` 用 `MemoryAudit().sink`，只进内存数组，进程退出即丢；无独立审计日志 |
| §8.4e hooks「matcher 三档 / 60s / payload 含 cwd / JSON decision」 | `contracts/hooks.ts` 无 matcher，默认 10s，payload 无 cwd，`HookOutcome.strict()` 只认 `action/reason/args` |
| §8.4b「headless flag 组已落地」 | 无 `--help`；`--disallowed-tools` TUI 无效；`-p` 在 pty 不走 headless |
| §9.2「转写展开/思考层已达标」 | Ctrl+O 对 Static 中已打印块无效 |
| §2.3「/compact 按完整轮次 + 锚点」 | 实际是"末尾 10 条消息"切片（`compact.ts:44-49`） |
| §2.1「真 tokenizer」 | `shared/index.ts:29` 是启发式估算 |
| §8.4f「工具面 13 个均实际承载需求」 | 工具 correctness 有多个 P0（错误码、预算、CRLF） |
| §9.1「工具链缺口：无」 | 缺 apply_patch/replace_all/读后校验/LSP 等 |

建议：把 DESIGN 的每个"已落地"改成三态 `[实现]`/`[部分]`/`[目标]`，并要求附一个测试文件或代码入口；`gates:check` 增加"声明链接存在性"校验。否则后续所有排期都会建立在虚假的完成度上。

### 6.2 安全模型是"确认驱动"，不是"隔离驱动"

当前所有边界（写、命令、MCP、hooks）最终都落到一个 UI 菜单。问题不在菜单，而在于：

- 没有 OS 沙箱：`fullAccess`/headless 下等于把 shell 交给模型。
- 审批在 hook 之前：hook 可在批准后改参。
- 凭据在环境变量里：bash 子进程可读。
- 读工具无边界：读 + web_fetch = 一条完整的零点击外泄链。
- 项目技能/agents 不经 `/trust` 就自动加载（只有 hooks 被 trust 门控）：克隆一个仓库、输入一个触发词，仓库里的 SKILL.md 正文就进上下文，其 description 甚至进系统提示。

**建议的优先级**：先做"最小可信执行"（env 清洗、read 边界、deny 规则、hook 后复核、项目扩展 trust 门控、SSRF 逐跳），再谈自动模式/沙箱。沙箱（Windows restricted token + job object）是差异化，但成本高，放在 P1 后半。

### 6.3 TUI 的 Static + 覆盖层架构在收利息

`<Static>` 决定了"已打印的块永不重绘"，于是详情、展开、编辑、diff 全部只能做成覆盖层；`Ctrl+O` 对历史无效、`/clear` 后 banner 可能被跳过、终端 resize 无法重排。继续加键位/面板是在给这个架构打补丁。建议做一次交互层重构（哪怕只做三件事）：

- 键位单一事实源（现在 Shift+Tab 有两个 handler，帮助文本又是第三份）。
- 帮助由命令表/键位表生成（现在 `/help` 手写且已过期）。
- 一个统一的"详情/审查"面板（工具输出全文、diff、会话回放共用），替代 Ctrl+B/Ctrl+T/DiffPreview 三套。

### 6.4 输入层自研 raw 处理，标准编辑键缺失

`InputBox` 自己接管 stdin，`Ctrl+*` 一律早退，导致 Ctrl+A/E/U/K/W、词移动、多行选择都没有；Home/End 靠 `stdin.read` tee 补丁，IME 靠 400ms 重绘补丁。建议引入成熟的 textarea/行编辑实现，或至少建立一张显式键位表（Emacs/vi 两套），不要继续用"补丁叠补丁"。

### 6.5 配置面太薄，先于功能扩张补齐

现在只有 `providers/default/budget` 三个键，`UserConfigFile.strict()` 导致加任何新键都启动失败；项目级只有一个 `default`（`ProjectConfigFile` 定义了却没用）。这会让"加功能"和"加配置"互相阻塞。建议先定 settings 层级（user → project → local → env → flag），再谈新命令。

### 6.6 功能广度 vs 主链路正确性

13 个工具、21 个命令、6 类扩展、MCP/插件/子代理/Web/Desktop 并行推进，但"读大文件、改 CRLF、跑测试看失败"三条日常链路都有 P0。对 3 人团队，这比"少一个市场"危险得多。建议 0.3 只承诺一件事：**在 Windows 上可靠地完成"修一个失败测试"**，其他都往后排。

---

## 7. 建议路线（只 CLI）

### 第 1–2 周：修信任（P0）

1. resume 透传 sessionId + 二次 resume 回归测试。
2. summarizer 失败必须抛 + 机械截断兜底 + 失败不应用。
3. 工具失败原因前置 + `ToolOutput.meta`（exitCode/truncated/artifactPath）。
4. `capToolResult` 按 token 重算 + read 续读提示 + 统一内部 cap。
5. edit EOL 归一 + `isWithinWorkspace` + `--add-dir`。
6. `-p` 即 headless + `--help/--version` + stdin 管道 + `--mode`/`--disallowed-tools` 语义。
7. env 清洗 + read denylist + SSRF 逐跳 + hook mutate 后复核。
8. `/clear`/`/resume` 传 `initialMode`。

### 第 3–6 周：日常可用（P1）

- 会话：图片落盘、`/resume` 列表按当前项目、切换/退出 close、检查点配额、导出走 JSONL。
- 工具：apply_patch/replace_all/读后校验；bash 输出流式、超时保留输出、进程树、artifact 路径前置；grep/glob 参数补齐；XLSX 修复；todo 回注；task 看门狗心跳 + usage 汇总。
- 扩展：hooks matcher + 上下文注入 + 兼容协议；插件 hooks/MCP/permissions 接线；命令 frontmatter/`!bash`/命名空间；skills 两个字段；项目级 MCP（trust 门控）+ headers/OAuth；subagent permissionMode。
- 模型：请求超时 + 溢出自动 compact+retry + headers/代理 + modelRef 语法 + env key + 窗口表可配。
- 交互：Shift+Tab 去重、`/help` 生成化、`exit` busy 保护、fatal 持久化、长输出查看、diff 审查、Ctrl+A/E 等编辑键。
- 工程：Windows CI（至少 matrix 加 windows-latest）、audit 落盘、保留策略。

### 第 7–12 周：差异化（P2）

- Windows 原生沙箱（restricted token + job object）+ 网络策略 + deny 策略文件。
- LSP/diagnostics、repo map。
- 会话 fork/命名/搜索、消息级编辑。
- auto memory、`.kcode/rules` 路径作用域。
- 主题/vim/命令面板/statusline。
- 插件市场/签名（N4）。

### 建议暂缓

Desktop/Web 继续推进前，先把 CLI 的"首用 + 安全 + 脚本化"做完；否则桌面只是把同样的坑放大到另一个壳。插件市场、i18n、遥测、computer-use 都应在 CLI 可信之后。

---

## 8. 证据索引

| 主题 | 文件:行 |
|---|---|
| 首用死锁 | `apps/cli/src/bootstrap.ts:48-54`、`main.tsx:224,374-382` |
| resume 丢历史 | `apps/cli/src/session.ts:142-161`、`packages/session/src/composition.ts:140-141`、`apps/host/src/session.ts:60-83` |
| 摘要失败吞历史 | `packages/platform/src/providers/summarizer.ts:31-45`、`openai-compatible.ts:165-170`、`core/src/context/compact.ts:115-120`、`core/src/core/loop.ts:263-269` |
| 错误码丢失 | `core/src/core/settle-results.ts:38-44`、`tools/src/tools/bash.ts:201-204`、`runtime/src/session/replayer.ts:139-144` |
| 预算失真 | `core/src/context/budget.ts:75-84`、`shared/src/index.ts:29-40`、`tools/src/tools/read.ts:6,66-74` |
| CRLF / 跨盘 | `tools/src/tools/read.ts:59-70`、`edit.ts:63,112-168`、`write.ts:16-25`、`edit.ts:49-54` |
| 脚本化 | `apps/cli/src/main.tsx:274,292-295`、`args.ts:135-139`、`headless.ts`（无 stdin） |
| 安全 | `main.tsx:245`、`tools/src/tools/bash.ts:298`、`extensions/src/permissions/safe-commands.ts:14`、`tools/src/tools/read.ts:38`、`web.ts:98-111,175`、`core/src/core/pipeline.ts:77-135` |
| 模式脱节 | `packages/session/src/composition.ts:413-415`、`apps/cli/src/tui/input/commands.ts:300-312`、`tui/state/lifecycle.ts:159-183` |
| Shift+Tab 双绑 | `apps/cli/src/tui/terminal/keybinds.ts:30-39,98-107` |
| 工具面 | `tools/src/tools/{grep,glob,bash,extract,task-tools}.ts`、`session/src/subagent.ts` |
| 扩展 | `packages/contracts/src/{hooks,skill,agent,mcp,plugin-manifest,provider}.ts`、`packages/session/src/composition.ts:237-245` |
| 更新链 | `apps/cli/src/update.ts:50-55,116-156` |
| TUI | `apps/cli/src/tui/transcript/TranscriptView.tsx:30-35`、`tui/state/events.ts:77`、`tui/dialogs/panels.tsx:34`、`tui/dialogs/ask-preview.ts`（tools） |

---

## 9. 待验证（静态无法定论）

- `process.exit` 在 Windows 管道上是否截断 doctor/NDJSON 尾部。
- MCP SDK `StdioClientTransport({env})` 是替换还是合并默认环境。
- `@ai-sdk/openai-compatible` 是否发 `stream_options.include_usage`（决定 usage 是否恒 0）。
- hooks 在 PowerShell 下 `exit $LASTEXITCODE` 对复合命令的可靠性。
- 并行工具崩溃后 OpenAI 兼容端点的具体 400 文本（P0-3 的严重度取决于它）。
- `oxlint max-lines 500` 是否真的放行 `core/loop.ts`(576)/`commands.ts`(547)/`composition.ts`(516)（`.oxlintrc.json` 无 overrides，若 CI 跑 oxlint 应报错——说明 CI 可能未真正执行或行数统计口径不同）。

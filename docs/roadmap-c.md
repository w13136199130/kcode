# C 级路线：单进程化（2026-09 决策记录）

## 1. 决策

**默认形态从「CLI 薄壳 + 常驻 daemon」切换为「Claude Code 同款单进程」**：
引擎内嵌 CLI 进程组装，会话状态落 JSONL 文件，`--resume` 续接，无守护进程。

## 2. 依据

### 行业对照

| 产品 | 架构 |
|---|---|
| Claude Code / Codex CLI / Gemini CLI / aider | 单进程 + 会话文件 + resume |
| OpenCode（SST） | client/server 分离 |
| ZCode（运行时行为观察） | 可见宿主进程拥有引擎（子代理/后台任务/交互全进程内）；会话持久化跨进程续接；cron 等跨调用能力走宿主应用模型 |

### daemon-first 的实测税负（本仓库亲身踩坑记录）

1. **环境继承错位**：daemon 继承首个终端的口令环境，换终端即"口令错误"（用户实撞 3 次）
2. **协议版本 churn**：PROTOCOL_VERSION 一周内 3→10，每加方法杀旧 daemon 重拉
3. **僵尸进程/死 pid/管道 EADDRINUSE**（实撞 2 次）、启动超时
4. 结论：为 P4（月级未来）的多前端收益，现在持续支付现货运维成本——**时序反了**

### 单进程化的结构红利

- 口令类 bug **结构性消失**（进程环境即终端环境）
- `composeSession` 是纯组装函数、loop 全端口注入——引擎不关心所在进程，改造成本低
- 会话 JSONL/resume/回放/rewind 语义完全不变

## 3. 已知代价（接受）

- bash 后台任务随 CLI 退出而终止（原 daemon 存续；P5 调度器会重新解决）
- 多前端并发（web 控制台）暂时搁置——P4 开工时再评估，不预置常驻进程

## 4. 实施（本次交付）

1. **packages/session（@kcode/session）**：composition / subagent / plan-submit / checkpoints 自 apps/daemon 抽出——引擎组装层成为共享包（对应 ARCHITECTURE「P3 后物理拆包」既定动作的提前执行）。
2. **CLI 内嵌**：`session.ts` 重写为本地会话（`createSession({ runtime, ... })` 进程内组装，接口形状与原远程句柄一致，App 层零语义变化）；`main.tsx` 以 `bootstrap()` 产出的 Runtime（配置/keychain/router）驱动，删除 ensureDaemon/daemon-client；权限确认的 diff 预览内移到本地会话层。
3. **apps/daemon 完全删除**：连同 `packages/contracts/src/localapi.ts`（本地 API 协议）一并移除；CLI 内的 daemon 残留表述同步清理。P4 web 控制台若需多端接入，届时重新评估形态（不再预置 `--serve` 底座）。
4. 会话事件照旧落 `~/.kcode/cli/sessions/*.jsonl`。

## 5. 后续（P4 前不再动架构）

- P4 web 控制台的多端接入形态届时再定（可能引入独立进程或 `--serve` 子命令，但不在当前代码中预置）
- 单进程下的后台任务语义随 P5 调度器重设计

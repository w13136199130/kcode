# Desktop 工作区 / 任务状态 RPC 例外登记

> 状态：**生效**
> 登记日期：2026-10-24
> 批准：产品负责人（本会话“继续吧”）
> 关联合同：[desktop-ui-implementation-plan.md](./desktop-ui-implementation-plan.md)

## 为什么需要

D3-UI 例外只允许 renderer/design token。工作区注册与信任必须由 host 持有：

- renderer 不能安全写 `~/.kcode`；
- 信任状态必须复用 `@kcode/session` 的 `trusted-projects.json`；
- 工作区必须有跨窗口持久化。

## 允许修改

- `apps/host/src/workspace-store.ts`（新增）
- `apps/host/src/task-state.ts`（新增）
- `apps/host/src/session-index.ts`（新增）
- `apps/host/src/session-trash.ts`（新增）
- `apps/host/src/server.ts`（workspace/*、sessions/archive、sessions/restore、sessions/list 合并索引/回收站、session/create 写索引）
- `apps/host/test/workspace-store.test.ts`
- `apps/host/test/task-state.test.ts`
- `apps/host/test/session-index.test.ts`
- `packages/contracts/src/host-protocol.ts`（仅新增 sessions/changed 事件）
- renderer 侧调用（`DesktopSidebar` / registry hook / session index helper）

## 不允许修改

- CLI / TUI 行为
- session 核心语义、会话文件格式
- LLM provider / tool / MCP / plugin 协议
- 把信任状态写进 `config.json` 或 renderer localStorage

## 方法

```text
workspace/list
workspace/add
workspace/remove
workspace/trust
workspace/status
sessions/archive
sessions/restore
sessions/purge
sessions/empty_trash
session/create（仅追加桌面会话索引写入）
```

存储：

```text
~/.kcode/desktop/projects.json
~/.kcode/desktop/task-state.json
~/.kcode/desktop/session-index.json
~/.kcode/desktop/session-trash.json
```

信任仍由：

```text
~/.kcode/trusted-projects.json
```

管理，host 只调用 `trustProject` / `isProjectTrusted`，不复制实现。

## 约束

- `workspace/remove` 只移除注册项，不删除目录、不删除会话；
- `sessions/archive` 只写 task-state.json，不移动/删除会话文件；
- `sessions/delete` 只写 session-trash.json（软删除），`sessions/restore` 撤销；不物理删除 JSONL；
- `sessions/purge` / `sessions/empty_trash` 只允许清理回收站中的会话，才物理删除 JSONL；
- `session-index.json` 只存会话 id/cwd/时间/摘要，消息仍在 JSONL；启动/列表时以 JSONL 校验/覆盖摘要；
- `workspace/trust` 只影响下一次 `session/create`，旧会话不热更新；
- 当前正在使用的工作区不能被 UI 静默移除；
- 失败返回错误，不伪造成功。

## 到期

- 2026-12-31
- Slice 4 合并后复核

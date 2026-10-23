# D3-UI 例外登记

> 状态：**生效**
> 登记日期：2026-10-23
> 批准：产品负责人（本会话明确批准“登记”）
> 关联合同：[desktop-ui-implementation-plan.md](./desktop-ui-implementation-plan.md)

## 例外内容

桌面 D3 仍保持冻结；本例外只允许 **桌面 UI 落地**，不允许借机扩展 CLI 或 host 能力。

### 允许修改

- `apps/desktop/src/renderer/**`
- `apps/desktop/src/renderer/styles.css`
- `packages/design/src/desktop.ts`（新增桌面专用 token）
- `packages/design/src/index.ts`（仅导出 desktop token）
- `apps/desktop/test/**`（UI 测试）
- `apps/desktop/scripts/dev.mjs`（仅清理 `ELECTRON_RUN_AS_NODE`，修复本地启动）
- `docs/desktop-ui-*`
- `knip.json`（仅忽略静态原型 `docs/desktop-ui-design/app.js`，避免把原型脚本误报为未使用文件）

### 不允许修改

- `apps/cli/**`
- `apps/host/**`
- `packages/contracts/**` 的协议语义
- `packages/session/**` 的会话语义
- TUI / CLI 行为
- 新增 provider、工具、MCP、插件协议

如果 Slice 1 发现必须改 host 才能继续，先停止并另开 host 变更评审，不在本例外内夹带。

## 第一个 slice 的范围

只做：

1. 纯白 desktop token；
2. `DesktopShell` / 产品标识；
3. 工作区/任务树；
4. 折叠、展开、选中；
5. 复用现有 `Timeline` / `Composer` / `useDesktopConnection`；
6. feature flag 与旧 UI 回退。

明确不做：

- 附件；
- 上下文百分比；
- 思考强度；
- Provider 套餐/额度；
- 项目注册表持久化；
- 项目信任 RPC；
- 归档；
- 终端 / 右侧面板；
- 插件市场 / 自动化。

## 约束

- 项目分组先由 `sessions/list.workspaceKey` 推导；
- 无项目的空状态可以显示，但不做持久化；
- 项目新增/信任要等 host RPC，不在 Slice 1 内假装可用；
- 当前会话删除保护沿用现有 host 行为；
- UI 必须可开关，默认不破坏旧界面。

## 到期与复核

- 到期日：**2026-12-31**
- 第一次复核：**Slice 1 合并后**
- 复核条件：
  - Slice 1 可回退；
  - desktop E2E 保持通过；
  - 未改 host/CLI；
  - 未出现假交互。

到期未完成则重新评估，不自动续期。

## 回滚

- feature flag 关闭即回旧 UI；
- 新增桌面 token 不改变现有 `WEB_LIGHT` / `WEB_DARK`；
- 不迁移会话文件，不改变 host 存储。

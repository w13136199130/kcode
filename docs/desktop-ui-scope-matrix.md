# Desktop 原型范围矩阵

> 状态：**P0 范围已冻结；Slice 1 / 工作区注册与信任 / Slice 2 Composer / Slice 3 设置页 / 主区域壳层 / 时间线 v2 / diff 详情栏 / 任务归档 / host 会话索引与回收站已落地（2026-10-24）**
> 目的：在 Slice 1 前冻结“哪些按钮真的做、哪些等 host、哪些先删”。
> 基线：`docs/desktop-ui-design/index.html` v23
> 落地计划：`docs/desktop-ui-implementation-plan.md`
> D3-UI 例外：`docs/desktop-ui-exception.md`

---

## 0. 结论

**不等 CLI 全部完成再开始桌面。**

CLI 的 P0/P1/P2 已收口，桌面壳的 Slice 1 只使用现有 `sessions/list`、`session/*`、`config/*`，不依赖 CLI 阶段四。

但要先把原型里的“假按钮”从 P0 切出去，否则桌面端会变成一套无法兑现的 UI。

推荐顺序：

```text
冻结范围
→ Slice 1：token + shell + 工作区树
→ Slice 2：Composer 重排
→ Slice 3：设置最小版
→ Host 项目注册/信任 RPC
→ 再评估附件/上下文/思考/终端/插件
```

---

## 1. 原型按钮全量分类

原型目前有 90+ 个 `data-action` 交互点。按产品能力分四类。

### A. P0：现在就能接现有 host

| 区域 | 交互 | 现有能力 |
|---|---|---|
| 产品标识 | 静态 logo / 产品名 / 本地徽标 | 纯 UI |
| 新建会话 | 创建草稿、进入当前工作区 | `session/create` |
| 工作区树 | 由 `sessions/list.workspaceKey` 分组 | 已有 |
| 工作区行 | 展开/折叠该工作区会话 | renderer 状态 |
| 工作区标题 | 整体展开/折叠工作区行 | renderer 状态 |
| 任务行 | 打开历史会话 | `session/create` + `resumeFrom` |
| 任务菜单 | 重命名 | `sessions/rename` |
| 任务菜单 | 删除非当前任务 | `sessions/delete` |
| 任务标题 | 展开/折叠未归类任务 | renderer 状态 |
| Composer | 发送、停止、排队 | `session/submit` / `interrupt` |
| Composer | 权限模式 | `session/set_mode` |
| Composer | 模型显示 | `config/get` 已有 |
| 时间线 | 工具展开、复制、重试 | 现有 projection |
| 变更/任务侧栏 | 打开、关闭、文件选择 | `session/changes` / `tasks` |
| 打开编辑器 | 打开 diff/文件 | Electron shell |
| 审批 | 四档审批 | `ask/respond` |
| 计划 | 批准/调整/放弃 | `plan/respond` |
| 提问 | 选项确认 | `question/respond` |
| 设置 | 外观、版本、默认模型 | 现有 SettingsOverlay |
| 命令面板 | 搜索命令/会话 | 现有 palette |
| Onboarding | 选择目录、配置 provider | `config/save` |

### B. P0.5：需要 host RPC，但只是薄层

| 交互 | 需要的 RPC | 说明 |
|---|---|---|
| 添加工作区 | `workspace/add` | `pickDirectory` 已有，缺持久化 |
| 删除工作区 | `workspace/remove` | 只删注册表，不删目录 |
| 归档工作区 | `workspace/archive` | `projects.json` 状态 |
| 信任工作区 | `workspace/trust` | 复用 session 包 `trustProject` |
| 工作区搜索/排序 | 可用 `sessions/list` 客户端排序 | 不需要新 RPC |
| 任务归档 | `sessions/archive` | 需要新持久化；P1 |

### C. P1/P2：必须等 CLI/core/协议

| 原型功能 | 阻塞点 |
|---|---|
| 附件 chips / `+` 附件 | `session/submit` 只有 text |
| 上下文 67% / 容量条 | 没有 live context/window |
| 思考强度 低/中/高 | provider 无能力元数据/请求参数 |
| Provider 套餐/额度 | 无真实订阅数据 |
| 终端底部面板 | 无 host 抽象 |
| 右侧“新标签页”面板 | 无 browser/terminal/review 协议 |
| 插件市场 | 无插件发现/安装 API |
| 自动化页面 | 无 scheduler/模板 API |
| 子智能体/MCP/技能/命令/Hooks 表单 | 大量 mock，缺完整 CRUD |
| 使用统计/归档管理 | 缺聚合/归档查询 |

### D. P0 应从 UI 中隐藏或删除

- 上下文百分比 `67%`；
- 思考强度徽标；
- Provider 套餐/额度卡；
- Composer 附件入口；
- 终端 / 右侧面板；
- 插件市场 / 自动化一级导航；
- 设置里的记忆、子智能体、MCP、技能、命令、Hooks、使用统计、归档；
- 工作区“归档”按钮（等 RPC）；
- `项目面板` 图标（当前无实现）。

> 这些不是“以后再说”的装饰，而是 P0 不能出现在用户眼前，避免被当成真功能。

---

## 2. 需要新增的功能项

只增加有后端依据的：

1. **工作区搜索**
   - 现有 workspace 标题搜索按钮目前是 mock dialog；
   - P0 可直接对 `sessions/list` 做客户端过滤。

2. **工作区排序**
   - 最近更新 / 名称 / 会话数；
   - 数据已在 `sessions/list`。

3. **任务重命名**
   - host 已有 `sessions/rename`；
   - 原型只做了菜单，没有真实输入闭环。

4. **变更回退**
   - host 有 `session/revert`；
   - 原型只有“打开编辑器”，缺少 revert 确认。

5. **连接断开/恢复入口**
   - desktop 启动链已修，但 host 崩溃仍需要明确重连提示；
   - 不是新增视觉，是错误态补齐。

6. **更新检查 / 帮助链接**
   - 帮助菜单已有占位；
   - 需要真实 URL/版本检查。

不建议新增：

- 更多一级导航；
- 更多设置页；
- 更多 mock 卡片；
- 自定义主题编辑器；
- 团队/计费/配额。

---

## 3. 优先级

```text
P0  UI shell + 工作区树 + 现有对话/Composer 等价能力
P0.5 工作区注册 + 信任 + 搜索排序 + 重命名/回退
P1  设置 Provider 管理 + 任务归档
P2  附件、上下文、思考、终端、插件、自动化
```

---

## 4. 桌面开发时机

### 现在就可以做

- Slice 1：token + shell + 工作区树；
- Slice 2：Composer 视觉重排；
- Slice 3：设置最小版。

理由：

- 只碰 renderer/design token；
- 不依赖 CLI 新能力；
- D3-UI 例外已登记；
- 有旧 UI feature flag 可回退。

### 不能现在做

- 项目注册/信任：需 host RPC；
- 附件/上下文/思考：需协议；
- 终端/插件/自动化：需产品能力。

### CLI 是否要先完成

不需要“全部完成”。CLI P0/P1/P2 已完成，阶段四 srt 不是桌面壳的依赖。建议并行：

```text
Track A：桌面 Slice 1/2/3
Track B：CLI 阶段四剩余
Track C：host 项目注册/信任（Slice 1 后）
```

---

## 5. 下一步

1. 冻结本矩阵为 P0 范围；
2. 从 `apps/desktop` 现有 `main.tsx` 拆 `DesktopShell`；
3. 加 `packages/design/src/desktop.ts`；
4. 用 `sessions/list` 做第一棵工作区树；
5. 开 feature flag，旧 UI 保留；
6. Slice 1 合并后再决定是否做 host RPC。

**不要继续加原型页面。**

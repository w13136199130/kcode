# 资产引用契约设计（S2-2 · 2026-10-27）

> 状态：**待评审**（登记于 [optimization-plan.md](./optimization-plan.md) S2-2；评审通过后实现第一批）
> 范围：图片（现状平迁）/ 视频 / 画布 / 素材库 共用的资产引用与存储契约。**本稿只定义引用与存储**，转码、缩略图、编辑留扩展位不实现（防过度设计）。

## 0. 问题（现状事实）

- P4-1 图片链路：renderer `pickImages`（主进程对话框）返回**临时目录绝对路径** → `session/submit {images}` → 原样写入 `user_message.images`（JSONL）。host **不做任何持久拷贝**——临时目录被清理后，resume 重建请求时图片丢失（附图会话重启即残废）。
- 即将到来的三个方向（素材库 / 视频生成 / 画布快照）若各自发明格式，将出现三套序列化、三套生命周期，返工成本最高。

## 1. 契约（packages/contracts/src/asset.ts，本稿随附落地）

```ts
AssetRef = {
  id: string            // ^ar_[a-z0-9]{8,24}$，进程内生成（crypto），非内容 hash
  path: string          // 存储内相对路径（store 相对，正斜杠），禁止绝对路径/..（zod refine）
  mime: string          // image/* | video/* | application/pdf | text/*（白名单分阶段开放）
  meta?: {
    bytes?: number      // 原始大小
    width?: number      // 图片/视频
    height?: number
    durationMs?: number // 视频/音频
    source?: "dialog" | "tool" | "generated" | "canvas"
  }
}
```

要点：
- **引用与所有权分离**：`AssetRef` 只出现在事件/消息里（引用），文件本体在 host 资产存储（所有权）。renderer 永远拿不到绝对路径——与 preload IPC 冻结原则一致。
- **id 非内容 hash**：去重/秒传是素材库阶段的事，第一版不做（YAGNI）；id 只需唯一。
- **path 存储内相对**：绝对路径随机器/迁移即碎（现状病灶），相对路径让整个 store 可搬迁。

## 2. 存储（host 侧）

```text
<kcodeHome>/assets/
  <sessionId>/
    <assetId>.<ext>          # 本体；ext 由 mime 映射，不接受调用方指定
    index.json               # 该会话资产清单 [{...AssetRef, createdAt}]
```

- 写入纪律**复用 session-index 已验证的三层**：进程内 Promise 队列 + 跨进程锁文件（`index.json.lock`，open wx + pid 存活检查，与 session-index 同一套实现抽公用）+ tmp/rename 原子替换；Windows Defender EPERM 处理同既有一致（重试后降级直写——清单损坏时按目录扫描重建，安全降级）。
- 生命周期挂在会话上：`sessions/delete`（回收站）不清资产；`purge/empty_trash` 级联删除目录；workspace 素材库（远期）用 `<workspaceKey>` 目录复用同构。

## 3. RPC（第一批实现范围）

| 方法 | 语义 |
|---|---|
| `session/attach {files: string[]}` | host 从本地路径**摄入**文件（copy 进存储，mime 嗅探 + 白名单 + 单文件 ≤20MB、单会话 ≤200 个），返回 `AssetRef[]`；提交前调用 |
| `session/submit {text, assets?: AssetRef[]}` | 事件里持久化的是 AssetRef（新字段），旧 `images` 路径字段保持兼容 |
| `session/asset {id}` | 读取本体（返回 base64 或临时 URL——第一批用 base64，视频阶段再换流式） |

**平迁策略（不破坏旧转写）**：`user_message.images`（旧，绝对路径）与 `user_message.assets`（新，AssetRef[]）并存；replay/resume 两侧都读——旧会话照常显示，新会话走新链路。CLI/TUI 零改动（不读该字段）。

## 4. 事件扩展位（视频/画布，本稿只占座）

- `canvas_update`（未来）：`{snapshot?: AssetRef, ops?: unknown[]}`——快照走同一资产存储，操作序列另行设计。
- 视频生成（未来）：工具产物直接 `source:"generated"` 进存储，消息里引用。
- 素材库（未来）：`workspace/assets` 目录 + 标签放 `meta`，与 会话资产同构。

## 5. 安全边界

- mime 白名单分阶段：第一批 `image/png|jpeg|webp|gif`（与 pickImages 过滤器一致）；video/pdf 后续随能力放开。
- `path` refine 禁 `..`、禁绝对路径、禁反斜杠；`id` 正则约束；`ext` 由 mime 表映射（防双扩展）。
- 容量上限可配（env `KCODE_ASSET_MAX_BYTES`/`MAX_COUNT` 覆盖）；超限明确报错不静默丢。

## 6. 验收（分两步）

1. **本稿（契约步）**：AssetRef zod schema + 单测（合法/非法路径/白名单外 mime/超长 id）——已随附。
2. **实现步（评审通过后）**：attach/submit/assets RPC + 存储三层写 + 图片链路平迁（新会话 images 改走 assets）+ E2E（附图→重启→resume 重建含图）+ 级联删除测试。

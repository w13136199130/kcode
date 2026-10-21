# srt 沙箱接入（4-01 M1）

> 状态：**实验/可选**。Windows 默认关闭；不改变现有权限/策略行为。
> srt（Anthropic Sandbox Runtime）Windows 后端仍是 alpha；我们不把自研沙箱作为主路线。

## 1. 目标与边界

目标：给 **bash 前台命令**增加 OS 级文件/网络隔离，同时保留 kcode 的权限、策略、审计与会话语义。

明确边界：

- 只覆盖 **bash 前台命令**（含 `!` 直执行与自定义命令里的 `!bash`）；`read/write/edit` 等进程内文件工具不受 srt 保护，仍由权限引擎 + `.kcode/policy.json` 约束；
- 默认 `KCODE_SANDBOX=off`，用户显式开启；
- srt 不可用时 **fail-closed**，不回退到无沙箱执行；
- 后台任务暂不支持沙箱（明确报错，不静默降级）；
- MXC 是未来后端，当前仅保留 adapter 占位。

## 2. 为什么是 srt

| 方案 | 结论 |
|---|---|
| 自研 AppContainer/restricted token | **不采用**：安全关键代码维护成本高，工具兼容性/ACL/WFP 长尾不可控 |
| Anthropic `srt` | **当前采用**：Node 22、Apache-2.0、已有 Windows 账户/WFP/write-restricted token/ACL |
| Microsoft MXC SDK | 未来：Node ≥24.21、主机支持 MXC/PSEC、包约 108MB；先留接口 |
| Docker/Podman | 可选但过重，不作为默认 |

srt 的 Windows 模型：

- 专用 `srt-sandbox` 本地账户；
- 机器级 WFP 出站过滤（按账户 SID）；
- write-restricted token；
- 工作区显式 ACL；
- HTTP/SOCKS 代理做域名 allowlist。

TUI 内也可以安装/修复：

```text
/sandbox install          # 默认 skip-profile-grant；已安装则直接提示，不重复 UAC
/sandbox install grant    # 显式授予 profile read（不推荐默认使用）
```

安装/验收脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/srt-sandbox.ps1 -Action install
# 可选：powershell ... -Action install -GrantProfileRead
```

验收：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/srt-sandbox.ps1 -Action verify
```

回滚：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/srt-sandbox.ps1 -Action uninstall
```

脚本等价于：

```powershell
# 默认 --skip-profile-grant（不授予 profile 读）
pnpm --filter @kcode/sandbox exec srt windows-install --skip-profile-grant
# 回滚
pnpm --filter @kcode/sandbox exec srt windows-uninstall
```

## 3. 使用

```powershell
# 默认关闭；查看状态
/sandbox

# 安装 srt
npx @anthropic-ai/sandbox-runtime windows-install

# 开启（workspace-write，网络默认 deny）
$env:KCODE_SANDBOX = "srt"
$env:KCODE_SANDBOX_MODE = "workspace-write"
# 从仓库根启动并显式指定 cwd；pnpm --filter 默认进程 cwd 是 apps/cli
pnpm --filter @kcode/cli start -- --cwd "$PWD"
```

环境变量：

| 变量 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `KCODE_SANDBOX` | `off` / `srt` / `auto` / `mxc` | `off` | `auto`：MXC 可用优先，否则 srt |
| `KCODE_SANDBOX_MODE` | `workspace-write` / `read-only` | `workspace-write` | 仅影响 srt 的 `allowWrite` |
| `KCODE_SANDBOX_DENY_READ` | `default` 或分号分隔路径 | 空 | 默认不启用；安装用了 `--skip-profile-grant` 时无必要；启用 profile grant 后再考虑 |
| `KCODE_SANDBOX_NETWORK` | 暂未开放 | `deny` | 当前固定 deny；allowlist 未接 |

## 4. 模块代码划分

依赖方向（单向）：

```text
@kcode/contracts          ← 纯契约，无 srt/MXC 类型
      ↑
@kcode/sandbox            ← Router + srt/MXC/none 适配器（唯一 import vendor 的地方）
      ↑
@kcode/tools              ← bash 只依赖 SandboxPort（contracts），不依赖 @kcode/sandbox
      ↑
@kcode/session            ← composition 创建 Router 并注入 bash
      ↑
apps/cli                  ← /sandbox 状态与安装指引
```

### 4.1 contracts

`packages/contracts/src/sandbox.ts`

```ts
SandboxMode, SandboxRequest, SandboxDenial, SandboxResult,
SandboxAvailability, SandboxPort
```

只定义跨包语义；不出现 `SandboxManager`、`MxcProcess`、srt settings 等 vendor 类型。

### 4.2 sandbox 包

```text
packages/sandbox/
  src/
    index.ts                 ← public exports
    router.ts                ← 选择后端、fail-closed
    policy.ts                ← 与 vendor 无关的 allowWrite/denyRead/网络策略
    backends/
      srt.ts                 ← 唯一 import @anthropic-ai/sandbox-runtime
      mxc.ts                 ← 未来 MXC adapter 占位
      none.ts                ← 显式关闭
  test/
    router.test.ts           ← 选择/回退/不静默
    policy.test.ts           ← 敏感路径/模式/网络映射
```

- `router.ts`：`KCODE_SANDBOX` 解析、`auto` 顺序、后端不可用错误；
- `policy.ts`：`policyFor()` 统一生成 `allowRead/allowWrite/denyRead/allowedHosts`，`toSrtConfig()` 只在这里翻译 srt 字段；MXC 以后写 `toMxcRequest()`，不改 tools；
- `srt.ts`：`available()`（Windows + 安装状态，结果缓存）、`run()`（写 settings/包装脚本 → 调用 `srt` CLI → 输出归一化；`onOutput` 把 stdout/stderr 增量推给 UI；不走库 `SandboxManager`，规避 persistent root 导致的 initialize 卡死）；同时从 stderr 提取 `denied`（路径拒绝）；
- `bash` 结果带 `sandbox` 元数据，`ToolPipeline` 写入 `AuditRecord.sandbox`；
- `/sandbox` 显示 setting/backend/mode/network/cwd/denyRead 与覆盖边界。
- `mxc.ts`：`available()` 返回不可用原因，`run()` fail-closed；接 MXC 时只改这里；
- `none.ts`：显式关闭的兜底。

默认 `denyRead` 为空：安装脚本默认 `--skip-profile-grant`，沙箱账户本来就读不到用户 profile，不需要再逐条 deny；若你显式启用了 profile grant，可设 `KCODE_SANDBOX_DENY_READ=default`（或分号列表）补敏感路径。srt alpha 在部分机器上对 denyRead 的 ACL stamp 可能很慢，先小范围验证。

### 4.3 tools

```text
packages/tools/src/tools/
  bash.ts                    ← 只判断 opts.sandbox 是否存在
  sandboxed-bash.ts          ← 沙箱前台执行、输出预算、cwd 边界
  shell-snapshot.ts          ← cwd 打点与提取（bash / sandboxed-bash 共用）
  test/bash-sandbox.test.ts  ← fake SandboxPort 集成测试
```

`bash.ts` 的沙箱分支只做：

1. 后台任务 + 沙箱 → 明确拒绝；
2. 前台 + sandbox → `runSandboxedBash`；
3. 把结果映射为 ToolResult；
4. 失败时不回退到原 `runShell`。

### 4.4 session

`packages/session/src/composition.ts`：

```ts
const sandbox = createSandboxPort();       // off → undefined
const sandboxMode = KCODE_SANDBOX_MODE ...;
createSessionTools({ ..., sandbox, sandboxMode });
```

不把 srt 配置写进 `bash.ts`，也不把权限策略和沙箱策略混在一起。

### 4.5 CLI

`/sandbox`：

- `off`：显示默认关闭 + 安装/开启指引；
- `install`：调用 `installSandbox()`（默认 skip-profile-grant；已安装则提示，不重复 UAC）；
- `install grant`：显式授予 profile read；
- 无参数：显示 setting/backend/mode/network/cwd/denyRead/覆盖边界；
- 不负责实际执行；执行仍由 bash 工具走 Router。

## 5. 新增 MXC 时要改什么

只新增/修改：

```text
packages/sandbox/src/backends/mxc.ts   ← 实现 SandboxPort
packages/sandbox/src/router.ts         ← auto 已预留 MXC 优先
```

不改：

- `packages/contracts/src/sandbox.ts`
- `packages/tools/src/tools/bash.ts`
- `packages/tools/src/tools/sandboxed-bash.ts`
- `packages/session/src/composition.ts`（已经注入 Router）
- `/sandbox` 展示（只显示 backend id）

MXC 前提：

- Node ≥24.21；
- `getPlatformSupport().isSupported`；
- 包体积/原生依赖可接受（约 108MB）；
- 先跑 conformance（工作区写、系统拒绝、网络拒绝、超时、进程树）。

## 6. 安全语义

| 项 | 行为 |
|---|---|
| 工作区写 | `workspace-write` 允许；`read-only` 不允许 |
| 系统目录写 | srt/write-restricted token + ACL 拒绝 |
| 敏感读 | 默认不额外 deny；`--skip-profile-grant` 下 profile 不可读；启用 profile grant 后可用 `KCODE_SANDBOX_DENY_READ` 收紧 |
| 网络 | 默认 deny；allowlist 未接 |
| 审计 | `ToolOutput.sandbox` → `AuditRecord.sandbox`；`/audit` 显示 `sandbox=<backend>/<mode>`，路径拒绝显示 `denied=path:<target>` |
| Git dubious ownership | adapter 把工作区根写入 srt `git.safeDirectories`，由 srt 只给该命令注入 `GIT_CONFIG_*`；不改用户全局 git config |
| 环境变量 | Windows srt 子进程使用 `srt-sandbox` 的 fresh profile 环境 + PATH/PATHEXT/代理 overlay；不继承 kcode 进程的全部 env（对 secret 有利，但依赖自定义 env 的工具可能失败） |
| 沙箱不可用 | `SandboxResult.sandboxed=false` + 错误；不执行原命令 |
| 后台任务 | 沙箱开启时明确拒绝 |
| 文件工具 | **不在 srt 边界内**；由 policy/permissions 约束 |
| 审计 | 当前只记录工具结果；backend 字段待接入审计 |

## 7. 验收

自动化（CI 可跑，不依赖 srt 安装）：

```powershell
pnpm vitest run packages/sandbox/test/router.test.ts packages/tools/test/bash-sandbox.test.ts
```

手工（Windows，需安装 srt）：

1. `/sandbox` 显示 srt 可用；
2. `echo ok > workspace.txt` 成功；
3. 写 `C:\Windows\...` 失败；
4. `curl https://example.com` 失败；
5. `git status` / `node -v` / `pnpm -v` 可用；
6. `/audit 10` 能看到 `sandbox=srt/workspace-write`，系统目录写失败带 `denied=path:`；
7. 退出后无残留后台进程；
8. 关闭 `KCODE_SANDBOX` 后行为恢复原样。

## 8. 故障排查

### 卡在 `Checking srt install status` / ACL

srt alpha 会为 workspace 保留 persistent write root；如果进程被杀、目录被删，下一次 ACL grant 可能很慢。先确认没有正在运行的 kcode，然后清理 root（会移除所有 persistent root）：

```powershell
# 从 pnpm store 里找到随包分发的 srt-win；执行前确认没有运行中的 kcode
$srtWin = Get-ChildItem node_modules\.pnpm -Recurse -Filter srt-win.exe |
  Select-Object -First 1 -ExpandProperty FullName
& $srtWin acl forget --all
```

脚本的 `-Action verify` 使用固定 `%TEMP%\kcode-srt-verify`，避免每次生成新 root；如果仍卡住，执行上面的清理后重试。

### `/sandbox` 显示不可用

- 未安装：按第 3 节运行 `windows-install`；
- 安装后仍不可用：重启 kcode（`available()` 有进程内缓存）；
- 显示 `profile read grant` 相关：默认 `--skip-profile-grant` 不授权 profile 读，这是预期行为。

### 命令被 ACL 拒绝

先记录完整命令和 cwd；不要直接关闭沙箱。大项目首次 ACL 可能较慢，固定 workspace 复用 root 通常更快。

## 8. 已知限制

- srt Windows 是 **alpha**，安装/账户/WFP 是机器级改动；
- srt 走 CLI 每命令一个进程；首次大项目/大 workspace 的 ACL grant 可能较慢，固定 workspace 可复用 persistent root；
- Windows 子进程只拿 fresh profile + PATH/PATHEXT/代理，不继承 kcode 的全部 env；需要自定义 env 的工具暂不支持；
- 默认不启用 `denyRead`；若启用 profile grant，必须自行评估敏感路径；
- 只覆盖前台 bash（含 `!` 直执行）；后台任务明确拒绝；
- 沙箱命令是流式 stdout/stderr（500ms 节流推 UI 尾部），但**没有 PTY/交互式终端**；
- 没有网络 allowlist；
- 网络拒绝目前主要靠 srt WFP/代理，不保证能像路径拒绝一样从 stderr 稳定解析出 `denied=network`；以命令实际失败为准；
- 没有把 sandbox backend/denial 写入 `/audit`（后续）；
- 没有自研沙箱；AppContainer spike 只作为技术验证/fallback，不产品化。

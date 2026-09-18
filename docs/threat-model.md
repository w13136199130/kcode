# kcode 威胁模型（P0 · 一页）

> §9 P0 交付物；§7 安全模型与"已知边界"声明的锚点。
> 资产：用户源码与会话内容（密文上云）、keychain 中的 API key 与设备私钥、更新通道、插件市场信任、relay 元数据。

## 信任边界（六处）与 STRIDE 主要项

| # | 边界 | 主要威胁（STRIDE） | 缓解（详见 ARCHITECTURE.md） |
|---|---|---|---|
| B1 | 项目配置 → providers/keyRef | I：伪装端点窃取 API key | 双作用域 schema（项目级无 `providers` 字段）+ key 受众绑定；§5.7 |
| B2 | 本地进程 → daemon 本地 API | S/T/E：任意进程连接、DNS rebinding、越权调用 | UDS/named pipe + 每用户 ACL；TCP 兜底 127.0.0.1 + Host/Origin/token；keychain 只在 daemon 进程内读取；§5.6.2 |
| B3 | 市场页面（UGC）→ 控制台（私钥） | I/T：XSS 偷设备私钥、UGC 注入 | 分源部署；sandboxed iframe + CSP；non-extractable 私钥 + passphrase 包裹；浏览器设备密钥只读级；§5.6 |
| B4 | 设备 ↔ relay（E2E） | S/R/I：设备冒充、撤销后仍读、密文泄露 | epoch 换钥 + relay 设备授权表；新设备需已授权设备批准；HKDF 逐消息 ratchet；§5.6.1 |
| B5 | 更新通道 → 客户端 | T/R/S：恶意更新、回滚攻击、伪造升级钓鱼 | TUF 角色分离（离线 root / 在线 release / timestamp）；带签名最低版本声明；原子替换 + 健康检查回滚；§5.6.3 |
| B6 | 插件市场 → 本机 | T/E/R：恶意插件、安装期 RCE、seed 篡改 | Sigstore keyless + registry 副签 + 扫描门 + 同意页 diff + `--ignore-scripts` + seed 锁定 + CRL；§5.8 |

## 横切

- 提示注入：全行业未解（已知边界 §7）——权限分级、第三方技能默认手动触发、审计留痕；
- 无人值守（cron/headless）：`automation` 权限模式，ask 降级为 deny + 通知；§5.5；
- 回放/eval 夹具：`replay: true`——hooks 不执行、工具以录制结果替代；§8.2。

## 明确不在范围

本地恶意软件、内核级攻击、0day。残留风险与对外口径见 §7"已知边界"。

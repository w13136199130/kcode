# 插件签名与加载期校验（4-08）

kcode 插件安装后会在 `~/.kcode/cli/plugins/cache/<name>/<version>/` 缓存。4-08 在原有 **内容 hash** 之外增加 **Ed25519 发布者签名**，把“内容没变”提升为“内容由受信任发布者发布且没变”。

## 1. 生成密钥

```powershell
kcode plugin keygen
```

生成：

```text
kcode-plugin.key    # 私钥（0600，不要提交）
kcode-plugin.pub    # 公钥
```

也可以指定目录：

```powershell
kcode plugin keygen .keys
```

## 2. 签名插件

插件源目录需包含合法的 `.kcode-plugin` 清单：

```powershell
kcode plugin sign .\my-plugin --key .\kcode-plugin.key
```

生成：

```text
my-plugin/.kcode-plugin.sig
```

签名覆盖：

```text
插件名
版本
内容 hash（排除 .kcode-plugin.sig 与 .kcode-seed.json）
```

因此修改清单、技能、命令、hooks 等任一内容都会导致验签失败。

## 3. 信任发布者

```powershell
kcode plugin trust .\kcode-plugin.pub "团队 A"
```

写入：

```text
~/.kcode/trusted-publishers.json
```

安装时也可以临时信任并入库：

```powershell
kcode plugin install .\my-plugin --trust-key .\kcode-plugin.pub
```

## 4. 安装流程

### 默认（兼容本地开发）

```powershell
kcode plugin install .\my-plugin
```

- 有签名：必须命中受信任公钥，否则拒绝安装；
- 无签名：允许安装，`plugin list` 标 `（未签名）`。

### 严格模式

```powershell
kcode plugin install .\my-plugin --require-signature
```

未签名插件直接拒装。

加载期全局严格模式：

```powershell
$env:KCODE_PLUGIN_REQUIRE_SIGNATURE = "1"
```

新会话装载时，未签名插件也会被拒绝。

## 5. 加载期校验

每次会话组装都会：

1. 重算插件目录 hash；
2. 与 `.kcode-seed.json` 的 hash 比对；
3. 若 seed 中带签名：
   - 按 keyId 找受信任公钥；
   - 验证 Ed25519 签名；
4. 任一步失败 → **拒绝装载并告警**。

`kcode plugin list` 显示：

```text
demo@1.0.0 ✍ <keyId>
other@1.0.0 （未签名）
bad@1.0.0 ⚠ 签名校验失败（签名校验失败）（会话拒绝装载）
```

## 6. 当前限制

- 使用本地 Ed25519 密钥，不接 Sigstore/OIDC；
- 没有密钥吊销/轮换/有效期；
- 未签名插件默认仍允许（只有 `--require-signature` / env 严格模式拒绝）；
- 信任库是本地 JSON，没有团队同步；
- `plugin list` 不校验证书链，只验证公钥签名；
- 安装包传输安全仍由下载来源负责。

Sigstore、TUF 更新链留给后续阶段。

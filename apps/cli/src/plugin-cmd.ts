import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  addTrustedKey,
  generateSigningKeyPair,
  hashPluginContent,
  installPlugin,
  listInstalledPlugins,
  loadTrustedKeys,
  readDisabledPlugins,
  readPluginManifest,
  setPluginEnabled,
  signPlugin,
  uninstallPlugin,
  verifyInstalledPlugin,
  writePluginSignature,
} from "@kcode/extensions";

/** 插件管理子命令：install/list/remove/enable/disable + 4-08 签名。 */
export async function pluginCommand(
  args: string[],
  kcodeHomeDir: string,
  print: (line: string) => void,
): Promise<void> {
  const pluginsDir = join(kcodeHomeDir, "cli", "plugins");
  const cacheDir = join(pluginsDir, "cache");
  const [op, ...rest] = args;

  if (op === "install" && rest[0] !== undefined) {
    const requireSignature = rest.includes("--require-signature");
    const trustKeyIndex = rest.indexOf("--trust-key");
    let trustedKeys = await loadTrustedKeys(kcodeHomeDir);
    if (trustKeyIndex !== -1 && rest[trustKeyIndex + 1] !== undefined) {
      const pem = await readFile(rest[trustKeyIndex + 1]!, "utf8");
      const entry = await addTrustedKey(kcodeHomeDir, pem, rest[trustKeyIndex + 1]);
      trustedKeys = [...trustedKeys.filter((key) => key.keyId !== entry.keyId), entry];
      print(`已信任发布者 ${entry.keyId}（${entry.publicKey.split("\n")[0]}…）`);
    }
    const result = await installPlugin(rest[0], cacheDir, { force: rest.includes("--force"), requireSignature, trustedKeys });
    print(`\n${result.consentSummary}\n`);
    print(`已安装 ${result.name}@${result.version} → ${result.installPath}`);
    print(`seed hash：${result.hash.slice(0, 16)}…`);
    return;
  }
  if (op === "keygen") {
    const dir = rest[0] ?? process.cwd();
    const pair = generateSigningKeyPair();
    const privatePath = join(dir, "kcode-plugin.key");
    const publicPath = join(dir, "kcode-plugin.pub");
    await writeFile(privatePath, pair.privateKey, { encoding: "utf8", mode: 0o600 });
    await writeFile(publicPath, pair.publicKey, "utf8");
    print(`已生成 Ed25519 密钥：\n  私钥：${privatePath}（不要提交）\n  公钥：${publicPath}\n  keyId：${pair.keyId}`);
    return;
  }
  if (op === "sign" && rest[0] !== undefined) {
    const keyIndex = rest.indexOf("--key");
    if (keyIndex === -1 || rest[keyIndex + 1] === undefined) {
      throw new Error("用法：kcode plugin sign <目录> --key <私钥.pem>");
    }
    const manifest = await readPluginManifest(rest[0]);
    const hash = await hashPluginContent(rest[0]);
    const privateKey = await readFile(rest[keyIndex + 1]!, "utf8");
    const sig = signPlugin(manifest.name, manifest.version, hash, privateKey);
    await writePluginSignature(rest[0], sig);
    print(`已签名 ${manifest.name}@${manifest.version} → ${join(rest[0], ".kcode-plugin.sig")}`);
    print(`keyId：${sig.keyId}`);
    return;
  }
  if (op === "trust" && rest[0] !== undefined) {
    const pem = await readFile(rest[0], "utf8");
    const entry = await addTrustedKey(kcodeHomeDir, pem, rest[1]);
    print(`已信任发布者 ${entry.keyId}（${entry.publicKey.split("\n")[0]}…）`);
    return;
  }
  if (op === "list") {
    const plugins = await listInstalledPlugins(cacheDir);
    if (plugins.length === 0) {
      print("（暂无已安装插件）");
      return;
    }
    const disabled = new Set(await readDisabledPlugins(pluginsDir));
    const trustedKeys = await loadTrustedKeys(kcodeHomeDir);
    for (const p of plugins) {
      const skills = p.manifest.skills.length > 0 ? ` 技能×${p.manifest.skills.length}` : "";
      const hooks = p.manifest.hooks.length > 0 ? ` hooks×${p.manifest.hooks.length}` : "";
      const mcp = p.manifest.mcp.length > 0 ? ` MCP×${p.manifest.mcp.length}` : "";
      const verified = await verifyInstalledPlugin(p, { trustedKeys });
      const sig =
        verified.signedBy !== undefined
          ? ` ✍ ${verified.signedBy}`
          : p.seed.sig === undefined || p.seed.sig === "local-install"
            ? " （未签名）"
            : "";
      const off = verified.ok
        ? disabled.has(p.manifest.name) || disabled.has(`${p.manifest.name}@${p.manifest.version}`)
          ? " [已停用]"
          : ""
        : ` ⚠ ${verified.reason ?? "校验失败"}（会话拒绝装载）`;
      print(`${p.manifest.name}@${p.manifest.version}${off}${sig}${skills}${hooks}${mcp}`);
    }
    return;
  }
  if (op === "remove" && rest[0] !== undefined) {
    const at = rest[0].indexOf("@");
    const name = at === -1 ? rest[0] : rest[0].slice(0, at);
    const version = at === -1 ? undefined : rest[0].slice(at + 1);
    print(await uninstallPlugin(cacheDir, name, version));
    return;
  }
  if ((op === "enable" || op === "disable") && rest[0] !== undefined) {
    await setPluginEnabled(pluginsDir, rest[0], op === "enable");
    print(op === "enable" ? `已启用 ${rest[0]}（新会话生效）` : `已停用 ${rest[0]}（新会话生效）`);
    return;
  }
  throw new Error(
    "用法：kcode plugin install <目录> [--force] [--require-signature] [--trust-key <公钥.pem>] ｜ keygen [目录] ｜ sign <目录> --key <私钥.pem> ｜ trust <公钥.pem> [标签] ｜ list ｜ remove <name>[@version] ｜ enable|disable <name>[@version]",
  );
}

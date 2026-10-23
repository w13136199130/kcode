import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addTrustedKey,
  buildExtensionRoots,
  generateSigningKeyPair,
  hashPluginContent,
  installPlugin,
  listInstalledPlugins,
  loadTrustedKeys,
  readPluginManifest,
  readPluginSignature,
  signPlugin,
  verifyInstalledPlugin,
  verifyPluginSignature,
  writePluginSignature,
} from "../src/index.js";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-signing-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makePlugin(name: string, version: string): Promise<string> {
  const dir = join(root, `${name}-${version.replace(/\./g, "-")}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, ".kcode-plugin"),
    JSON.stringify({
      schema: "kcode.plugin/1",
      name,
      version,
      hooks: [],
      skills: [],
      commands: [],
      agents: [],
      mcp: [],
      permissions: [],
    }),
    "utf8",
  );
  await writeFile(join(dir, "README.md"), "signed plugin", "utf8");
  return dir;
}

describe("4-08 插件签名", () => {
  it("签名/验签覆盖 name+version+hash", async () => {
    const dir = await makePlugin("signed-a", "1.0.0");
    const manifest = await readPluginManifest(dir);
    const hash = await hashPluginContent(dir);
    const key = generateSigningKeyPair();
    const sig = signPlugin(manifest.name, manifest.version, hash, key.privateKey);
    expect(verifyPluginSignature(sig, key.publicKey)).toBe(true);
    expect(verifyPluginSignature(sig, generateSigningKeyPair().publicKey)).toBe(false);

    await writePluginSignature(dir, sig);
    expect((await readPluginSignature(dir))?.keyId).toBe(key.keyId);
    // 签名文件不计入内容哈希（否则自引用）
    expect(await hashPluginContent(dir)).toBe(hash);
  });

  it("签名插件必须命中受信任密钥；未知发布者拒绝安装", async () => {
    const dir = await makePlugin("signed-b", "1.0.0");
    const hash = await hashPluginContent(dir);
    const key = generateSigningKeyPair();
    await writePluginSignature(dir, signPlugin("signed-b", "1.0.0", hash, key.privateKey));

    await expect(
      installPlugin(dir, join(root, "cache-b"), { trustedKeys: [] }),
    ).rejects.toThrow(/未受信任/);
    const result = await installPlugin(dir, join(root, "cache-b"), {
      trustedKeys: [{ keyId: key.keyId, publicKey: key.publicKey, addedAt: Date.now() }],
    });
    const installed = (await listInstalledPlugins(join(root, "cache-b"))).find((p) => p.manifest.name === "signed-b")!;
    expect(installed.seed.sig).toMatch(new RegExp(`^ed25519:${key.keyId}:`));
    expect(result.hash).toBe(hash);
    expect(await verifyInstalledPlugin(installed, { trustedKeys: [{ keyId: key.keyId, publicKey: key.publicKey, addedAt: 0 }] }))
      .toMatchObject({ ok: true, signedBy: key.keyId });
  });

  it("strict 模式拒绝未签名插件；默认允许本地开发", async () => {
    const dir = await makePlugin("unsigned", "1.0.0");
    await expect(installPlugin(dir, join(root, "cache-u"), { requireSignature: true })).rejects.toThrow(/未签名/);
    const result = await installPlugin(dir, join(root, "cache-u"));
    expect(result.name).toBe("unsigned");
  });

  it("安装后篡改内容 → hash 校验失败", async () => {
    const dir = await makePlugin("tamper", "1.0.0");
    const cache = join(root, "cache-t");
    await installPlugin(dir, cache);
    await writeFile(join(cache, "tamper", "1.0.0", "README.md"), "tampered", "utf8");
    const installed = (await listInstalledPlugins(cache))[0]!;
    const check = await verifyInstalledPlugin(installed, { trustedKeys: [] });
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("内容");
  });

  it("Windows UTF-8 BOM 清单仍可读取", async () => {
    const dir = await makePlugin("bom-plugin", "1.0.0");
    const raw = await (await import("node:fs/promises")).readFile(join(dir, ".kcode-plugin"), "utf8");
    await writeFile(join(dir, ".kcode-plugin"), `\uFEFF${raw}`, "utf8");
    expect((await readPluginManifest(dir)).name).toBe("bom-plugin");
  });

  it("strict 加载模式拒绝未签名插件", async () => {
    const dir = await makePlugin("strict-load", "1.0.0");
    const khome = join(root, "strict-home");
    await installPlugin(dir, join(khome, "cli", "plugins", "cache"));
    process.env["KCODE_PLUGIN_REQUIRE_SIGNATURE"] = "1";
    try {
      const warnings: string[] = [];
      const roots = await buildExtensionRoots({ cwd: root, kcodeHomeDir: khome, onWarn: (m) => warnings.push(m) });
      expect(roots.plugins.map((p) => p.manifest.name)).not.toContain("strict-load");
      expect(warnings.some((m) => m.includes("未签名"))).toBe(true);
    } finally {
      delete process.env["KCODE_PLUGIN_REQUIRE_SIGNATURE"];
    }
  });

  it("信任库持久化公钥并按 keyId 去重", async () => {
    const home = join(root, "home");
    const key = generateSigningKeyPair();
    const first = await addTrustedKey(home, key.publicKey, "团队 A");
    const second = await addTrustedKey(home, key.publicKey, "团队 A2");
    expect(first.keyId).toBe(second.keyId);
    const keys = await loadTrustedKeys(home);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.label).toBe("团队 A2");
  });
});

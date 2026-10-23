import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PLUGIN_SIGNATURE_FILE = ".kcode-plugin.sig";

export interface PluginSignature {
  schema: "kcode.plugin.sig/1";
  algorithm: "ed25519";
  keyId: string;
  signature: string;
  payload: {
    name: string;
    version: string;
    hash: string;
  };
}

export interface TrustedPublisherKey {
  keyId: string;
  publicKey: string;
  addedAt: number;
  label?: string;
}

interface TrustStore {
  version: 1;
  keys: TrustedPublisherKey[];
}

/** 签名覆盖的规范载荷：名称/版本/内容哈希，缺一不可。 */
function pluginSignaturePayload(name: string, version: string, hash: string): Buffer {
  return Buffer.from(`kcode.plugin/1\n${name}\n${version}\n${hash}`, "utf8");
}

/** 公钥指纹（SHA-256 前 16 hex）；私钥可推导公钥，但签名文件只记录公钥派生 keyId。 */
export function keyIdFor(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem.trim()).digest("hex").slice(0, 16);
}

export function generateSigningKeyPair(): { privateKey: string; publicKey: string; keyId: string } {
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privateKey, publicKey, keyId: keyIdFor(publicKey) };
}

export function publicKeyFromPrivate(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem))
    .export({ type: "spki", format: "pem" })
    .toString();
}

export function signPlugin(name: string, version: string, hash: string, privateKeyPem: string): PluginSignature {
  const publicKey = publicKeyFromPrivate(privateKeyPem);
  const keyId = keyIdFor(publicKey);
  const signature = sign(null, pluginSignaturePayload(name, version, hash), privateKeyPem).toString("base64");
  return {
    schema: "kcode.plugin.sig/1",
    algorithm: "ed25519",
    keyId,
    signature,
    payload: { name, version, hash },
  };
}

export function verifyPluginSignature(sig: PluginSignature, publicKeyPem: string): boolean {
  if (sig.schema !== "kcode.plugin.sig/1" || sig.algorithm !== "ed25519") return false;
  if (keyIdFor(publicKeyPem) !== sig.keyId) return false;
  try {
    return verify(
      null,
      pluginSignaturePayload(sig.payload.name, sig.payload.version, sig.payload.hash),
      publicKeyPem,
      Buffer.from(sig.signature, "base64"),
    );
  } catch {
    return false;
  }
}

export async function readPluginSignature(dir: string): Promise<PluginSignature | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, PLUGIN_SIGNATURE_FILE), "utf8")) as PluginSignature;
    return parsed.schema === "kcode.plugin.sig/1" ? parsed : null;
  } catch {
    return null;
  }
}

export async function writePluginSignature(dir: string, sig: PluginSignature): Promise<void> {
  await writeFile(join(dir, PLUGIN_SIGNATURE_FILE), `${JSON.stringify(sig, null, 2)}\n`, "utf8");
}

export function trustStorePath(kcodeHomeDir: string): string {
  return join(kcodeHomeDir, "trusted-publishers.json");
}

export async function loadTrustedKeys(kcodeHomeDir: string): Promise<TrustedPublisherKey[]> {
  try {
    const parsed = JSON.parse(await readFile(trustStorePath(kcodeHomeDir), "utf8")) as Partial<TrustStore>;
    return Array.isArray(parsed.keys) ? parsed.keys : [];
  } catch {
    return [];
  }
}

export async function addTrustedKey(
  kcodeHomeDir: string,
  publicKeyPem: string,
  label?: string,
): Promise<TrustedPublisherKey> {
  const clean = publicKeyPem.trim();
  if (!clean.includes("BEGIN PUBLIC KEY")) throw new Error("不是合法的 PEM 公钥");
  const keyId = keyIdFor(clean);
  const keys = await loadTrustedKeys(kcodeHomeDir);
  const entry: TrustedPublisherKey = {
    keyId,
    publicKey: clean,
    addedAt: Date.now(),
    ...(label !== undefined && label.trim() !== "" ? { label: label.trim() } : {}),
  };
  const next = keys.filter((key) => key.keyId !== keyId);
  next.push(entry);
  await mkdir(kcodeHomeDir, { recursive: true });
  await writeFile(
    trustStorePath(kcodeHomeDir),
    `${JSON.stringify({ version: 1, keys: next } satisfies TrustStore, null, 2)}\n`,
    "utf8",
  );
  return entry;
}

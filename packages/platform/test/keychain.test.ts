import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EncryptedFileKeychain } from "../src/auth/keychain.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "kcode-key-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("加密文件 keychain（P1 降级，§5.7）", () => {
  it("set/get 往返；落盘内容不含明文 key", async () => {
    const file = join(dir, "keys.json");
    const kc = new EncryptedFileKeychain(file, "passphrase-1");
    await kc.set("keychain://deepseek", "sk-secret", ["https://api.deepseek.com/v1"]);

    const entry = await kc.get("keychain://deepseek");
    expect(entry?.key).toBe("sk-secret");
    expect(entry?.audiences).toEqual(["https://api.deepseek.com/v1"]);

    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("sk-secret");

    // 新实例（同口令）可读回
    const kc2 = new EncryptedFileKeychain(file, "passphrase-1");
    expect((await kc2.get("keychain://deepseek"))?.key).toBe("sk-secret");
  });

  it("口令错误解密失败", async () => {
    const file = join(dir, "keys2.json");
    await new EncryptedFileKeychain(file, "right").set("keychain://a", "k", []);
    await expect(new EncryptedFileKeychain(file, "wrong").get("keychain://a")).rejects.toThrow(
      /解密失败/,
    );
  });

  it("delete / list", async () => {
    const file = join(dir, "keys3.json");
    const kc = new EncryptedFileKeychain(file, "p");
    await kc.set("keychain://x", "k", []);
    await kc.set("keychain://y", "k", []);
    expect(await kc.list()).toEqual(["keychain://x", "keychain://y"]);
    await kc.delete("keychain://x");
    expect(await kc.list()).toEqual(["keychain://y"]);
    expect(await kc.get("keychain://x")).toBeNull();
  });

  it("fromEnv 缺口令时显式报错（禁止假保护）", () => {
    const saved = process.env["KCODE_KEYCHAIN_PASSPHRASE"];
    process.env["KCODE_KEYCHAIN_PASSPHRASE"] = "";
    try {
      expect(() => EncryptedFileKeychain.fromEnv(join(dir, "k.json"))).toThrow(/PASSPHRASE/);
    } finally {
      if (saved === undefined) {
        delete process.env["KCODE_KEYCHAIN_PASSPHRASE"];
      } else {
        process.env["KCODE_KEYCHAIN_PASSPHRASE"] = saved;
      }
    }
  });
});

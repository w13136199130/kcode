import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlatformService } from "../src/platform-service.js";
import { DpapiKeychain } from "../src/auth/dpapi-keychain.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "kcode-platsvc-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 构造被测服务：路径指向临时目录，不碰真实 ~/.kcode */
function svc() {
  return createPlatformService({
    keysFile: join(dir, "keys.json"),
    dpapiKeysFile: join(dir, "keys.dpapi.json"),
  });
}

describe("createPlatformService（IPlatformService 默认实现，N2-1）", () => {
  it("secureStorageAvailable 与平台事实一致（Windows DPAPI）", () => {
    expect(svc().secureStorageAvailable).toBe(DpapiKeychain.available);
  });

  it("openPassphraseKeychain：set/get/list 往返（显式口令，不依赖环境）", async () => {
    const kc = svc().openPassphraseKeychain("口令-A");
    await kc.set("keychain://deepseek", "sk-test-123", ["https://api.deepseek.com"]);
    expect(await kc.list()).toEqual(["keychain://deepseek"]);
    const entry = await kc.get("keychain://deepseek");
    expect(entry?.key).toBe("sk-test-123");
    expect(entry?.audiences).toEqual(["https://api.deepseek.com"]);
    // 同口令新实例可解密（落盘往返，非内存缓存）
    const again = svc().openPassphraseKeychain("口令-A").get("keychain://deepseek");
    expect((await again)?.key).toBe("sk-test-123");
  });

  it("openPassphraseKeychain：错误口令解不开（list 抛错）", async () => {
    await svc().openPassphraseKeychain("口令-A").set("keychain://glm", "sk-x", ["https://open.bigmodel.cn"]);
    await expect(svc().openPassphraseKeychain("口令-B").list()).rejects.toThrow();
  });

  it("verifyEnvPassphrase：口令对 true / 口令错 false（环境变量口径）", async () => {
    await svc().openPassphraseKeychain("口令-A").set("keychain://glm", "sk-x", ["https://open.bigmodel.cn"]);
    const prev = process.env["KCODE_KEYCHAIN_PASSPHRASE"];
    try {
      process.env["KCODE_KEYCHAIN_PASSPHRASE"] = "口令-A";
      expect(await svc().verifyEnvPassphrase()).toBe(true);
      process.env["KCODE_KEYCHAIN_PASSPHRASE"] = "口令-B";
      expect(await svc().verifyEnvPassphrase()).toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env["KCODE_KEYCHAIN_PASSPHRASE"];
      } else {
        process.env["KCODE_KEYCHAIN_PASSPHRASE"] = prev;
      }
    }
  });

  it("openSecureKeychain：Windows 往返 / 其他平台抛错（口令不能为空语义）", async () => {
    if (DpapiKeychain.available) {
      const kc = svc().openSecureKeychain();
      await kc.set("keychain://glm", "sk-y", ["https://open.bigmodel.cn"]);
      const entry = await kc.get("keychain://glm");
      expect(entry?.key).toBe("sk-y");
    } else {
      expect(() => svc().openSecureKeychain()).toThrow(/口令不能为空/);
    }
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DpapiKeychain } from "../src/index.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "kcode-dpapi-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("DpapiKeychain（仅 Windows 实跑；其他平台跳过）", () => {
  it("set/get/list/delete 往返：条目按 DPAPI 加密落盘，list 不触发解密", async () => {
    if (process.platform !== "win32") {
      return;
    }
    const file = join(dir, "keys.dpapi.json");
    const kc = new DpapiKeychain(file);
    await kc.set("keychain://deepseek", "sk-test-123-中文🔑", ["https://api.deepseek.com"]);
    expect(await kc.list()).toEqual(["keychain://deepseek"]);
    // 新实例强制从磁盘解密，不能用 set() 留在内存中的明文缓存代替往返。
    const entry = await new DpapiKeychain(file).get("keychain://deepseek");
    expect(entry?.key).toBe("sk-test-123-中文🔑");
    expect(entry?.audiences).toEqual(["https://api.deepseek.com"]);
    // 落盘内容不含明文 key
    const raw = await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8"));
    expect(raw).not.toContain("sk-test-123");
    await kc.delete("keychain://deepseek");
    expect(await kc.list()).toEqual([]);
    expect(await kc.get("keychain://deepseek")).toBeNull();
  }, 30_000);
});

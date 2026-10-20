import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EncryptedFileKeychain } from "../src/auth/keychain.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "kcode-keychain-atomic-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("2-18 keychain 原子写", () => {
  it("多次 set 后主文件可读，且保留上一版 .bak", async () => {
    const path = join(dir, "keys.json");
    const kc = new EncryptedFileKeychain(path, "test-pass");
    await kc.set("keychain://a", "ka", ["https://a.test"]);
    await kc.set("keychain://b", "kb", ["https://b.test"]);

    const reopened = new EncryptedFileKeychain(path, "test-pass");
    expect(await reopened.list()).toEqual(["keychain://a", "keychain://b"]);
    expect(await reopened.get("keychain://b")).toMatchObject({ key: "kb" });
    expect(existsSync(`${path}.bak`)).toBe(true);
  });
});

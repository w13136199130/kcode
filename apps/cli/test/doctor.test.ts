import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IPlatformService } from "@kcode/contracts";
import type { KeychainStore } from "@kcode/platform";
import { doctorCommand } from "../src/doctor.js";

let home: string;
const lines: string[] = [];
const collect = (line: string): void => {
  lines.push(line);
};

/** 最小假平台：DPAPI 不可用 + 可注入的内存 keychain（probe 走 platformClientAdapter 包装） */
function fakePlatform(keychain: KeychainStore): IPlatformService {
  return {
    secureStorageAvailable: false,
    openDefaultKeychain: () => keychain,
    verifyEnvPassphrase: async () => true,
  } as unknown as IPlatformService;
}

const emptyKeychain: KeychainStore = {
  async get() {
    return null;
  },
  async set() {},
  async delete() {},
  async list() {
    return [];
  },
};

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-doctor-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("kcode doctor（N3C-2）", () => {
  it("健康环境：全项 ✓ 且返回 true（key 探测走假 keychain）", async () => {
    const keychain: KeychainStore = {
      ...emptyKeychain,
      async get(ref: string) {
        return ref === "keychain://demo"
          ? { ref, key: "k", audiences: ["https://example.test/v4"] }
          : null;
      },
    };
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        models: {
          default: "prov/model",
          providers: { prov: { type: "openai-compatible", baseURL: "https://example.test/v4", keyRef: "keychain://demo" } },
        },
      }),
      "utf8",
    );
    lines.length = 0;
    const ok = await doctorCommand(fakePlatform(keychain), collect, home);
    expect(ok).toBe(true);
    expect(lines.some((l) => l.startsWith("✓ 配置与默认模型") && l.includes("prov/model"))).toBe(true);
    expect(lines.some((l) => l.startsWith("✓ 默认模型 key") && l.includes("keychain://demo"))).toBe(true);
    expect(lines.some((l) => l.startsWith("✓ ripgrep"))).toBe(true);
    expect(lines.some((l) => l.startsWith("✓ 会话目录可写"))).toBe(true);
    expect(lines.at(-1)).toMatch(/全部 \d+ 项检查通过/);
  });

  it("配置缺失：该条 ✗、key 探测跳过、整体返回 false", async () => {
    const emptyHome = await mkdtemp(join(tmpdir(), "kcode-doctor-empty-"));
    try {
      lines.length = 0;
      const ok = await doctorCommand(fakePlatform(emptyKeychain), collect, emptyHome);
      expect(ok).toBe(false);
      expect(lines.some((l) => l.startsWith("✗ 配置与默认模型"))).toBe(true);
      // 配置失败时 key 探测不应再产出一条误导性的结果
      expect(lines.some((l) => l.includes("默认模型 key"))).toBe(false);
      expect(lines.at(-1)).toMatch(/\d+ 项需要处理/);
    } finally {
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it("keychain 中缺默认 key：探测 ✗ 且给出修复指引", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        models: {
          default: "prov/model",
          providers: { prov: { type: "openai-compatible", baseURL: "https://example.test/v4", keyRef: "keychain://missing" } },
        },
      }),
      "utf8",
    );
    lines.length = 0;
    const ok = await doctorCommand(fakePlatform(emptyKeychain), collect, home);
    expect(ok).toBe(false);
    expect(lines.some((l) => l.startsWith("✗ 默认模型 key") && l.includes("kcode key add"))).toBe(true);
  });

  it("mcp.json 不合法：✗ 并带解析错误", async () => {
    await writeFile(join(home, "mcp.json"), "{oops", "utf8");
    lines.length = 0;
    await doctorCommand(fakePlatform(emptyKeychain), collect, home);
    expect(lines.some((l) => l.startsWith("✗ MCP 配置"))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { KeychainEntry, UserModelsConfig } from "@kcode/contracts";
import { UserModelsConfig as UserModelsConfigSchema } from "@kcode/contracts";
import type { KeychainStore } from "../src/auth/keychain.js";
import { createProviderRouter, parseModelRef } from "../src/providers/route.js";

class MemoryKeychain implements KeychainStore {
  #map = new Map<string, KeychainEntry>();
  async get(ref: string): Promise<KeychainEntry | null> {
    return this.#map.get(ref) ?? null;
  }
  async set(ref: string, key: string, audiences: string[]): Promise<void> {
    this.#map.set(ref, { ref, key, audiences });
  }
  async delete(ref: string): Promise<void> {
    this.#map.delete(ref);
  }
  async list(): Promise<string[]> {
    return [...this.#map.keys()];
  }
}

const config: UserModelsConfig = UserModelsConfigSchema.parse({
  default: "deepseek/chat",
  providers: {
    deepseek: {
      type: "openai-compatible",
      baseURL: "https://api.deepseek.com/v1",
      keyRef: "keychain://deepseek",
    },
    ollama: { type: "openai-compatible", baseURL: "http://127.0.0.1:11434/v1" },
    openai: { type: "openai", keyRef: "keychain://openai" },
    kcode: { type: "gateway" },
  },
});

describe("providers 路由（§5.7）", () => {
  it("模型引用解析：provider/model 与裸模型名", () => {
    expect(parseModelRef("deepseek/chat", config)).toEqual({ providerName: "deepseek", modelId: "chat" });
    // 裸模型名沿用 default 的 provider
    expect(parseModelRef("glm-4.7", config)).toEqual({ providerName: "deepseek", modelId: "glm-4.7" });
  });

  it("受众匹配时成功创建 provider", async () => {
    const kc = new MemoryKeychain();
    await kc.set("keychain://deepseek", "sk-1", ["https://api.deepseek.com/v1"]);
    const provider = await createProviderRouter(config, kc).resolve("deepseek/chat");
    expect(provider.id).toBe("openai-compatible:deepseek");
  });

  it("受众不匹配 → 硬失败（第二层防御核心用例）", async () => {
    const kc = new MemoryKeychain();
    await kc.set("keychain://deepseek", "sk-1", ["https://api.deepseek.com/v1"]);
    // 模拟配置被篡改：baseURL 指向攻击者，但 keyRef 仍指向真 key
    const tampered: UserModelsConfig = {
      ...config,
      providers: {
        ...config.providers,
        deepseek: {
          type: "openai-compatible",
          baseURL: "https://attacker.example/v1",
          keyRef: "keychain://deepseek",
        },
      },
    };
    await expect(createProviderRouter(tampered, kc).resolve("deepseek/chat")).rejects.toThrow(/受众/);
  });

  it("keyRef 存在但 keychain 无条目 → 报错", async () => {
    await expect(createProviderRouter(config, new MemoryKeychain()).resolve("deepseek/chat")).rejects.toThrow(
      /keychain 中找不到/,
    );
  });

  it("网关模式给出 P5 提示", async () => {
    await expect(createProviderRouter(config, new MemoryKeychain()).resolve("kcode/x")).rejects.toThrow(/P5/);
  });

  it("openai 类型固定官方端点", async () => {
    const kc = new MemoryKeychain();
    await kc.set("keychain://openai", "sk-o", ["https://api.openai.com/v1"]);
    const provider = await createProviderRouter(config, kc).resolve("openai/gpt-4o");
    expect(provider.id).toBe("openai-compatible:openai");
  });

  it("无 key 本地端点（Ollama）可直接创建", async () => {
    const provider = await createProviderRouter(config, new MemoryKeychain()).resolve("ollama/qwen2.5-coder");
    expect(provider.id).toBe("openai-compatible:ollama");
  });

  it("未配置的 provider 报错", async () => {
    await expect(createProviderRouter(config, new MemoryKeychain()).resolve("nope/x")).rejects.toThrow(
      /未配置/,
    );
  });
});

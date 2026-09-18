import { describe, expect, it } from "vitest";
import {
  PluginName,
  ProjectConfigFile,
  UserModelsConfig,
  pluginNamespace,
} from "../src/index.js";

describe("ProviderConfig 双作用域（§5.7 第一层防御）", () => {
  it("项目级出现 providers 字段即 parse error", () => {
    const malicious = {
      models: {
        providers: {
          evil: { type: "openai-compatible", baseURL: "https://evil.example/v1" },
        },
      },
    };
    expect(() => ProjectConfigFile.parse(malicious)).toThrow();
  });

  it("项目级只能按名引用默认模型", () => {
    expect(ProjectConfigFile.parse({ models: { default: "deepseek" } })).toEqual({
      models: { default: "deepseek" },
    });
  });

  it("用户级接受文档 §5.7 示例配置（含 keyRef）", () => {
    const parsed = UserModelsConfig.parse({
      default: "glm-4.7",
      providers: {
        kcode: { type: "gateway" },
        openai: { type: "openai", keyRef: "keychain://openai" },
        deepseek: {
          type: "openai-compatible",
          baseURL: "https://api.deepseek.com/v1",
          keyRef: "keychain://deepseek",
        },
        local: { type: "openai-compatible", baseURL: "http://127.0.0.1:11434/v1" },
      },
    });
    expect(parsed.providers?.deepseek?.type).toBe("openai-compatible");
  });

  it("非法 baseURL 被 schema 拒绝", () => {
    expect(
      UserModelsConfig.safeParse({
        providers: { bad: { type: "openai-compatible", baseURL: "not-a-url" } },
      }).success,
    ).toBe(false);
  });
});

describe("插件清单路径正则（§4.3 防穿越）", () => {
  it("拒绝路径穿越与非法名", () => {
    expect(PluginName.safeParse("../evil").success).toBe(false);
    expect(PluginName.safeParse("a/b").success).toBe(false);
    expect(PluginName.safeParse("a\\b").success).toBe(false);
    expect(PluginName.safeParse(".hidden").success).toBe(false);
  });

  it("接受合法名并生成命名空间", () => {
    expect(PluginName.safeParse("code-review").success).toBe(true);
    expect(pluginNamespace("code-review", "review")).toBe("plugin:code-review::review");
  });
});

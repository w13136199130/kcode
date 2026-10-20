import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveUserProvider } from "../src/config.js";

let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-host-config-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("D1-02 宿主配置保存", () => {
  it("provider 级 merge：保留 budget 与已有 provider，只覆盖目标", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        models: {
          default: "glm/glm-5.3",
          providers: { glm: { type: "openai-compatible", baseURL: "https://a.example/v1", keyRef: "keychain://glm" } },
        },
        budget: { maxSessionTokens: 123456 },
        futureRoot: true,
      }),
      "utf8",
    );
    await saveUserProvider(home, {
      providerName: "deepseek",
      provider: { type: "openai-compatible", baseURL: "https://b.example/v1", keyRef: "keychain://deepseek" },
      model: "deepseek/deepseek-chat",
    });
    const raw = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as {
      models: { default: string; providers: Record<string, unknown> };
      budget: { maxSessionTokens: number };
      futureRoot: boolean;
    };
    expect(raw.models.default).toBe("deepseek/deepseek-chat");
    expect(raw.models.providers["glm"]).toBeDefined();
    expect(raw.models.providers["deepseek"]).toBeDefined();
    expect(raw.budget.maxSessionTokens).toBe(123456);
    expect(raw.futureRoot).toBe(true);
  });

  it("非法 provider 配置拒绝写入", async () => {
    await expect(
      saveUserProvider(home, {
        providerName: "bad",
        provider: { type: "openai-compatible", baseURL: "not-a-url" } as never,
        model: "bad/x",
      }),
    ).rejects.toThrow(/配置不合法/);
  });
});

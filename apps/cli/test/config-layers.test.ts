import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadUserConfig, resolveModelOverride, loadSessionBudgetTokens } from "../src/bootstrap.js";

/** N3E-3：配置三层覆盖（用户级 providers 唯一 → Project 仅 default → Env 白名单）。 */
let home: string;
let ws: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-cfg-home-"));
  ws = await mkdtemp(join(tmpdir(), "kcode-cfg-ws-"));
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      models: {
        default: "user/default-model",
        providers: { user: { type: "openai-compatible", baseURL: "https://u.test/v4", keyRef: "keychain://k1" } },
      },
    }),
    "utf8",
  );
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(ws, { recursive: true, force: true });
});

describe("N3E-3 配置覆盖层", () => {
  it("无覆盖：用户级 default 原样", async () => {
    const models = await loadUserConfig(join(home, "config.json"));
    expect(models.default).toBe("user/default-model");
  });

  it("Project 层仅覆盖 default（providers 投毒被忽略）", async () => {
    await mkdir(join(ws, ".kcode"), { recursive: true });
    await writeFile(
      join(ws, ".kcode", "config.json"),
      JSON.stringify({
        models: {
          default: "project/override",
          providers: { evil: { type: "openai-compatible", baseURL: "https://evil.test", keyRef: "keychain://k2" } },
        },
      }),
      "utf8",
    );
    const models = await loadUserConfig(join(home, "config.json"), { cwd: ws });
    expect(models.default).toBe("project/override");
    expect(models.providers["evil"]).toBeUndefined();
    expect(models.providers["user"]).toBeDefined();
  });

  it("Env 白名单优先级最高；项目配置损坏按无覆盖", async () => {
    const models = await loadUserConfig(join(home, "config.json"), {
      cwd: ws,
      env: { KCODE_DEFAULT_MODEL: "env/model" },
    });
    expect(models.default).toBe("env/model");
    await writeFile(join(ws, ".kcode", "config.json"), "{broken", "utf8");
    const models2 = await loadUserConfig(join(home, "config.json"), {
      cwd: ws,
      env: { KCODE_DEFAULT_MODEL: "" },
    });
    expect(models2.default).toBe("user/default-model");
  });
});

describe("N3F-5 --model 第四层覆盖（resolveModelOverride）", () => {
  it("provider/model 且 provider 已配置：原样通过", () => {
    const models = { default: "user/default-model", providers: { user: { type: "gateway" as const } } };
    expect(resolveModelOverride(models, "user/other-model")).toBe("user/other-model");
  });

  it("未知 provider fail-fast 并列出可用清单", () => {
    const models = { providers: { user: { type: "gateway" as const }, ollama: { type: "gateway" as const } } };
    expect(() => resolveModelOverride(models, "nope/x")).toThrow(/nope" 未配置——可用：user、ollama/);
  });

  it("格式不合法 fail-fast", () => {
    const models = { providers: { user: { type: "gateway" as const } } };
    expect(() => resolveModelOverride(models, "Bad/Name")).toThrow(/格式不合法/);
    expect(() => resolveModelOverride(models, "")).toThrow(/格式不合法/);
  });

  it("裸模型名沿 default 的 provider；无 default 前缀则要求 provider/model 形式", () => {
    const withDefault = { default: "user/default-model", providers: { user: { type: "gateway" as const } } };
    expect(resolveModelOverride(withDefault, "other-model")).toBe("other-model");
    const noDefault = { providers: { user: { type: "gateway" as const } } };
    expect(() => resolveModelOverride(noDefault, "other-model")).toThrow(/provider\/model 形式/);
  });
});

describe("N3I-8 会话 token 预算读取（loadSessionBudgetTokens）", () => {
  it("用户级 budget 生效；env 覆盖；缺失/非法回 undefined", async () => {
    const cfg = join(home, "budget.json");
    await writeFile(cfg, JSON.stringify({ budget: { maxSessionTokens: 500_000 } }), "utf8");
    expect(await loadSessionBudgetTokens(cfg, {})).toBe(500_000);
    expect(await loadSessionBudgetTokens(cfg, { KCODE_BUDGET_TOKENS: "800000" })).toBe(800_000);
    // env 非正整数忽略，回落配置
    expect(await loadSessionBudgetTokens(cfg, { KCODE_BUDGET_TOKENS: "-3" })).toBe(500_000);
    expect(await loadSessionBudgetTokens(cfg, { KCODE_BUDGET_TOKENS: "abc" })).toBe(500_000);
    // 文件缺失 / 无 budget 键 → undefined（预算关）
    expect(await loadSessionBudgetTokens(join(home, "nope.json"), {})).toBeUndefined();
    await writeFile(join(home, "nobudget.json"), JSON.stringify({ models: {} }), "utf8");
    expect(await loadSessionBudgetTokens(join(home, "nobudget.json"), {})).toBeUndefined();
  });
});

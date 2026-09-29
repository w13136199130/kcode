import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadUserConfig } from "../src/bootstrap.js";

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

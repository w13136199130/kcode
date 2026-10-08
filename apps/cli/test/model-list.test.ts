import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KeychainStore, ProviderRouter } from "@kcode/platform";
import type { IPlatformService } from "@kcode/contracts";
import type { Runtime } from "../src/bootstrap.js";
import { createSession } from "../src/session.js";

/** 对齐批 B：availableModels——router → provider.listModels 透传与会话级缓存 */

let home: string;
let workspace: string;
let savedCwd: string;

const keychain: KeychainStore = {
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
  home = await mkdtemp(join(tmpdir(), "kcode-modelist-"));
  workspace = await mkdtemp(join(tmpdir(), "kcode-modelist-ws-"));
  savedCwd = process.cwd();
  process.chdir(workspace);
});
afterAll(async () => {
  process.chdir(savedCwd);
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

function runtimeWith(provider: { listModels?: () => Promise<string[]> }): {
  runtime: Runtime;
  resolves: { count: number };
} {
  const resolves = { count: 0 };
  const runtime = {
    models: { providers: {}, default: "test/m" },
    keychain,
    router: {
      resolve: async () => {
        resolves.count += 1;
        return { id: "test:p", stream: async function* () {}, ...provider };
      },
    } as unknown as ProviderRouter,
    platform: {} as IPlatformService,
    kcodeHomeDir: home,
  } as unknown as Runtime;
  return { runtime, resolves };
}

describe("availableModels（/model 全量菜单数据源）", () => {
  it("透传 provider.listModels；会话级缓存（二次调用不再 resolve）", async () => {
    const { runtime, resolves } = runtimeWith({ listModels: async () => ["m-a", "m-b"] });
    const session = await createSession({ runtime, model: "test/m", cwd: workspace });
    const before = resolves.count; // createSession 自身已 resolve 一次（initialLlm）
    expect(await session.availableModels()).toEqual(["m-a", "m-b"]);
    expect(await session.availableModels()).toEqual(["m-a", "m-b"]);
    expect(resolves.count - before).toBe(1); // 缓存生效：两次调用只多 resolve 一次
    await session.close();
  }, 30_000);

  it("provider 无 listModels 或抛错：返回空（调用方回退配置态）", async () => {
    const { runtime } = runtimeWith({});
    const session = await createSession({ runtime, model: "test/m", cwd: workspace });
    expect(await session.availableModels()).toEqual([]);
    await session.close();
  }, 30_000);
});

describe("modelWindowNote（N3I-3 /model 菜单窗口注记）", () => {
  it("表内模型标窗口，表外标 ?（不猜）", async () => {
    const { modelWindowNote } = await import("../src/tui/input/commands.js");
    expect(modelWindowNote("deepseek/deepseek-v4-pro")).toBe("· 1000k");
    expect(modelWindowNote("deepseek/deepseek-chat")).toBe("· 128k");
    expect(modelWindowNote("qwen/qwen-max")).toBe("· 131k");
    expect(modelWindowNote("test/m")).toBe("· ?");
  });
});

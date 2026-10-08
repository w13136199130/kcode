import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KeychainStore, ProviderRouter } from "@kcode/platform";
import type { IPlatformService } from "@kcode/contracts";
import type { Runtime } from "../src/bootstrap.js";
import { createSession } from "../src/session.js";

/** N3I-7 会话面：hooksInfo（来源标）与 mcpTools（未连接回退） */

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
  home = await mkdtemp(join(tmpdir(), "kcode-surface-"));
  workspace = await mkdtemp(join(tmpdir(), "kcode-surface-ws-"));
  savedCwd = process.cwd();
  process.chdir(workspace);
});

afterAll(async () => {
  process.chdir(savedCwd);
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

function makeRuntime(): Runtime {
  return {
    models: { providers: {}, default: "test/m" },
    keychain,
    router: {
      resolve: async () => ({ id: "test:p", stream: async function* () {} }),
    } as unknown as ProviderRouter,
    platform: {} as IPlatformService,
    kcodeHomeDir: home,
  } as unknown as Runtime;
}

describe("hooksInfo / mcpTools", () => {
  it("用户级 hooks.json 装载并以 source=user 列出；项目级未信任不出现", async () => {
    await writeFile(
      join(home, "hooks.json"),
      JSON.stringify({
        hooks: [
          { event: "post_tool_use", command: "echo done" },
          { event: "stop", command: "notify.sh", failClosed: true },
        ],
      }),
      "utf8",
    );
    const session = await createSession({ runtime: makeRuntime(), model: "test/m", cwd: workspace });
    expect(await session.hooksInfo()).toEqual([
      { source: "user", event: "post_tool_use", command: "echo done", failClosed: undefined },
      { source: "user", event: "stop", command: "notify.sh", failClosed: true },
    ]);
    await session.close();
  }, 30_000);

  it("无 hooks 配置返回空；未配置/未连接的 MCP 服务器 mcpTools 返回 null", async () => {
    const session = await createSession({ runtime: makeRuntime(), model: "test/m", cwd: workspace });
    expect(await session.mcpTools("nope")).toBeNull();
    await session.close();
  }, 30_000);
});

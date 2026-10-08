import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "@kcode/contracts";
import { mcpCommand } from "../src/mcp-cmd.js";

/** N3F-6：kcode mcp 子命令——list/add/remove/test 与原子写 */

let home: string;
const out: string[] = [];
const print = (s: string): void => {
  out.push(s);
};
const run = (sub: string[], opts: { connect?: never } = {}): Promise<boolean> =>
  mcpCommand(sub, print, { home, ...opts });

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-mcp-home-"));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

async function readServers(): Promise<McpServerConfig[]> {
  const raw = JSON.parse(await readFile(join(home, "mcp.json"), "utf8")) as { servers: McpServerConfig[] };
  return raw.servers;
}

describe("kcode mcp add/list/remove", () => {
  it("list 空态；add stdio（-- 后命令与参数）；list 呈现", async () => {
    expect(await run(["list"])).toBe(true);
    expect(out.at(-1)).toContain("未配置");
    expect(await run(["add", "fetch", "--", "npx", "-y", "mcp-server-fetch"])).toBe(true);
    const servers = await readServers();
    expect(servers).toEqual([{ name: "fetch", transport: "stdio", command: "npx", args: ["-y", "mcp-server-fetch"] }]);
    expect(await run(["list"])).toBe(true);
    expect(out.at(-1)).toContain("fetch  [stdio]  npx -y mcp-server-fetch");
  });

  it("add http（url + 默认 transport）；--transport sse；非法 transport 报错", async () => {
    expect(await run(["add", "remote", "https://mcp.example.com/api"])).toBe(true);
    expect((await readServers()).find((s) => s.name === "remote")).toEqual({
      name: "remote",
      transport: "http",
      args: [],
      url: "https://mcp.example.com/api",
    });
    expect(await run(["add", "legacy", "https://old.example.com/sse", "--transport", "sse"])).toBe(true);
    expect(await run(["add", "bad", "https://x.test", "--transport", "ws"])).toBe(false);
    expect(out.at(-1)).toContain("http | sse");
  });

  it("同名拒加；remove 未知报错并列出；remove 成功后文件同步", async () => {
    expect(await run(["add", "fetch", "--", "npx"])).toBe(false);
    expect(out.at(-1)).toContain("先 kcode mcp remove fetch");
    expect(await run(["remove", "nope"])).toBe(false);
    expect(await run(["remove", "fetch"])).toBe(true);
    expect((await readServers()).map((s) => s.name)).toEqual(["remote", "legacy"]);
  });

  it("非法名（schema）与非法形态 fail-fast", async () => {
    expect(await run(["add", "Bad Name", "--", "npx"])).toBe(false);
    expect(await run(["add", "x", "not-a-url"])).toBe(false);
    expect(out.at(-1)).toContain("形式不合法");
  });

  it("损坏的 mcp.json：list 失败；add 拒绝覆盖", async () => {
    await writeFile(join(home, "mcp.json"), "{broken", "utf8");
    expect(await run(["list"])).toBe(false);
    expect(await run(["add", "newone", "--", "npx"])).toBe(false);
    expect(out.at(-1)).toContain("不会覆盖损坏的文件");
  });
});

describe("kcode mcp test", () => {
  it("连接成功报工具数；失败报原因；未知名报错", async () => {
    await writeFile(
      join(home, "mcp.json"),
      JSON.stringify({ servers: [{ name: "ok", transport: "stdio", command: "x", args: [] }] }),
      "utf8",
    );
    const fakeConnect = vi.fn(async (configs: McpServerConfig[]) => [
      {
        name: configs[0]!.name,
        transport: configs[0]!.transport,
        tools: [
          { definition: { name: "mcp__ok__fetch", description: "", parameters: {} }, execute: async () => ({ ok: true, output: "" }) },
          { definition: { name: "mcp__ok__search", description: "", parameters: {} }, execute: async () => ({ ok: true, output: "" }) },
        ],
        close: async () => {},
      },
    ]);
    expect(await mcpCommand(["test", "ok"], print, { home, connect: fakeConnect as never })).toBe(true);
    expect(out.at(-1)).toContain("✓ ok 连接成功，提供 2 个工具：fetch、search");
    expect(fakeConnect).toHaveBeenCalledOnce();

    const failing = vi.fn(async (_configs: McpServerConfig[], opts?: { onWarn?: (m: string) => void }) => {
      opts?.onWarn?.("boom");
      return [];
    });
    expect(await mcpCommand(["test", "ok"], print, { home, connect: failing as never })).toBe(false);
    expect(out.at(-1)).toContain("✗ 连接失败：boom");

    expect(await run(["test", "ghost"])).toBe(false);
    expect(out.at(-1)).toContain("未找到 ghost");
  });
});

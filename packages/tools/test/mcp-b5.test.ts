import { describe, expect, it } from "vitest";
import { McpServerConfig } from "@kcode/contracts";
import { withMcpTimeout } from "../src/mcp/provider.js";

describe("MCP 配置 schema（B5 三传输）", () => {
  it("stdio 需 command；http/sse 需 url；缺者校验失败", () => {
    expect(McpServerConfig.safeParse({ name: "fs", command: "node" }).success).toBe(true);
    expect(McpServerConfig.safeParse({ name: "fs", transport: "stdio" }).success).toBe(false);
    expect(
      McpServerConfig.safeParse({ name: "api", transport: "http", url: "https://x.dev/mcp" }).success,
    ).toBe(true);
    expect(McpServerConfig.safeParse({ name: "api", transport: "http" }).success).toBe(false);
    expect(McpServerConfig.safeParse({ name: "api", transport: "sse", url: "https://x.dev/sse" }).success).toBe(true);
    // 旧配置（无 transport 字段）默认 stdio，向后兼容
    const legacy = McpServerConfig.safeParse({ name: "fs", command: "node", args: [] });
    expect(legacy.success && legacy.data.transport).toBe("stdio");
  });
});

describe("withMcpTimeout（挂死护栏）", () => {
  it("正常返回值透传", async () => {
    expect(await withMcpTimeout(Promise.resolve(42), 1000, "x")).toBe(42);
  });
  it("超时拒绝并携带标签", async () => {
    const never = new Promise<number>((_) => {});
    await expect(withMcpTimeout(never, 50, "MCP fs.listTools ")).rejects.toThrow("超时");
  });
});

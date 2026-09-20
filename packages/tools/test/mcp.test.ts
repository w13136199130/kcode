import { describe, expect, it } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServerConfig } from "@kcode/contracts";
import { connectMcpServer, connectMcpServers } from "../src/index.js";

/** 构造一个内存 MCP 测试服务器：提供 echo 工具 */
async function makeTestServerPair(): Promise<{
  clientTransport: ReturnType<typeof InMemoryTransport.createLinkedPair>[0];
}> {
  const server = new Server({ name: "test-server", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "echo",
        description: "回显输入",
        inputSchema: { type: "object", properties: { msg: { type: "string" } } },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, (request) => ({
    content: [{ type: "text", text: `回显：${String((request.params.arguments as { msg?: unknown })?.msg ?? "")}` }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { clientTransport };
}

const serverConfig: McpServerConfig = {
  name: "demo",
  transport: "stdio",
  command: "node",
  args: [],
};

describe("MCP 接入（内存传输）", () => {
  it("列出工具并以 mcp__前缀命名；调用结果回填为文本", async () => {
    const { clientTransport } = await makeTestServerPair();
    const session = await connectMcpServer(serverConfig, () => clientTransport);
    expect(session.tools).toHaveLength(1);
    const tool = session.tools[0]!;
    expect(tool.definition.name).toBe("mcp__demo__echo");
    expect(tool.definition.description).toBe("回显输入");

    const result = await tool.execute({ msg: "你好" }, { sessionId: "s" });
    expect(result).toEqual({ ok: true, output: "回显：你好" });
    await session.close();
  });

  it("批量接入：单个失败不阻断，转为告警", async () => {
    const { clientTransport } = await makeTestServerPair();
    const warns: string[] = [];
    const sessions = await connectMcpServers(
      [serverConfig, { ...serverConfig, name: "bad" }],
      {
        transportFactory: (config) => {
          if (config.name === "bad") {
            throw new Error("连接拒绝");
          }
          return clientTransport;
        },
        onWarn: (m) => warns.push(m),
      },
    );
    expect(sessions).toHaveLength(1);
    expect(warns.some((w) => w.includes("bad") && w.includes("接入失败"))).toBe(true);
    await Promise.all(sessions.map((s) => s.close()));
  });

  it("服务器返回 isError 时映射为失败结果", async () => {
    const server = new Server({ name: "err-server", version: "0.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [{ name: "boom", description: "必失败", inputSchema: { type: "object" } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, () => ({
      content: [{ type: "text", text: "内部错误详情" }],
      isError: true,
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const session = await connectMcpServer({ ...serverConfig, name: "err" }, () => clientTransport);
    const result = await session.tools[0]!.execute({}, { sessionId: "s" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("内部错误详情");
    await session.close();
  });
});

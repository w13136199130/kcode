import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
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

  it("3-14 annotations.readOnlyHint → readOnly + plan 放行；未声明保持可写", async () => {
    const server = new Server({ name: "ro-server", version: "0.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        { name: "lookup", description: "只读查询", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
        { name: "mutate", description: "写入", inputSchema: { type: "object" } },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: "text", text: "ok" }] }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const session = await connectMcpServer({ ...serverConfig, name: "ro" }, () => clientTransport);
    const lookup = session.tools.find((t) => t.definition.name.endsWith("lookup"))!;
    const mutate = session.tools.find((t) => t.definition.name.endsWith("mutate"))!;
    expect(lookup.definition.readOnly).toBe(true);
    expect(lookup.definition.permission).toEqual({ default: "ask", plan: "allow" });
    expect(mutate.definition.readOnly).toBe(false);
    expect(mutate.definition.permission).toEqual({ default: "ask" });
    await session.close();
  });

  it("3-14 图片内容落盘为 imagePaths；structuredContent 附加文本", async () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const server = new Server({ name: "media-server", version: "0.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [{ name: "media", description: "图文", inputSchema: { type: "object" } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, () => ({
      content: [
        { type: "text", text: "说明文字" },
        { type: "image", data: png, mimeType: "image/png" },
        { type: "resource_link", uri: "https://example.com/x", name: "参考" },
      ],
      structuredContent: { ok: true, n: 1 },
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const session = await connectMcpServer({ ...serverConfig, name: "media" }, () => clientTransport);
    const result = await session.tools[0]!.execute({}, { sessionId: "s" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("说明文字");
    expect(result.output).toContain("[资源链接 参考");
    expect(result.output).toContain("[结构化结果]");
    expect(result.imagePaths).toHaveLength(1);
    const bytes = await readFile(result.imagePaths![0]!);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await session.close();
  });

  it("3-14 signal 中断：Esc 立即结束等待 MCP 调用", async () => {
    const server = new Server({ name: "hang-server", version: "0.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [{ name: "hang", description: "挂起", inputSchema: { type: "object" } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, () => new Promise(() => {}));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const session = await connectMcpServer({ ...serverConfig, name: "hang" }, () => clientTransport);
    const controller = new AbortController();
    const pending = session.tools[0]!.execute({}, { sessionId: "s", signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow(/取消/);
    await session.close();
  });

  it("3-14 传输断开：自动重连并重试一次", async () => {
    const first = await makeTestServerPair();
    const second = await makeTestServerPair();
    let created = 0;
    const session = await connectMcpServer(serverConfig, () => {
      created += 1;
      return created === 1 ? first.clientTransport : second.clientTransport;
    });
    // 掐断第一条连接（模拟服务端退出/网络断）
    await first.clientTransport.close();
    const result = await session.tools[0]!.execute({ msg: "重连" }, { sessionId: "s" });
    expect(created).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("重连");
    await session.close();
  });
});

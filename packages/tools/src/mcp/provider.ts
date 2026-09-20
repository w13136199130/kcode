import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig, Tool } from "@kcode/contracts";

export interface McpSession {
  /** 接入成功后暴露的工具，命名为 mcp__<服务器>__<工具>（与权限规则命名空间一致） */
  tools: Tool[];
  /** 断开连接并结束子进程 */
  close(): Promise<void>;
}

/** 工具内容块的宽松形态：只取 text 部分回填给模型 */
interface LooseContent {
  type?: string;
  text?: string;
}

/**
 * 连接一个 MCP 服务器（stdio 传输，独立进程）：
 * 列出其工具并包装为内置同构的 Tool——权限、审计、钩子对 MCP 工具同样生效。
 * transportFactory 供测试注入内存传输；生产默认启动 command 子进程。
 */
export async function connectMcpServer(
  config: McpServerConfig,
  transportFactory?: () => Transport,
): Promise<McpSession> {
  const client = new Client({ name: "kcode", version: "0.1.0" });
  const transport =
    transportFactory !== undefined
      ? transportFactory()
      : new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env,
        });
  await client.connect(transport);

  const listed = (await client.listTools()) as unknown as {
    tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  };
  const tools: Tool[] = (listed.tools ?? []).map((tool) => ({
    definition: {
      name: `mcp__${config.name}__${tool.name}`,
      description: tool.description ?? `MCP 工具 ${config.name}/${tool.name}`,
      parameters:
        (tool.inputSchema as { type?: string })?.type === "object"
          ? (tool.inputSchema as Record<string, unknown>)
          : { type: "object" },
      readOnly: false,
    },
    execute: async (input) => {
      const result = (await client.callTool({
        name: tool.name,
        arguments: (input ?? {}) as Record<string, unknown>,
      })) as unknown as { content?: LooseContent[]; isError?: boolean };
      const output = (result.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
      if (result.isError === true) {
        return { ok: false, output, error: output !== "" ? output : "MCP 工具执行失败" };
      }
      return { ok: true, output };
    },
  }));

  return {
    tools,
    close: async () => {
      await client.close();
    },
  };
}

/** 批量接入：单个服务器失败不阻断整体，失败项转为告警 */
export async function connectMcpServers(
  configs: McpServerConfig[],
  options: { transportFactory?: (config: McpServerConfig) => Transport; onWarn?: (message: string) => void } = {},
): Promise<McpSession[]> {
  const results = await Promise.allSettled(
    configs.map((config) =>
      connectMcpServer(config, options.transportFactory !== undefined ? () => options.transportFactory!(config) : undefined),
    ),
  );
  const sessions: McpSession[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      sessions.push(result.value);
    } else {
      const name = configs[index]?.name ?? "未知";
      options.onWarn?.(
        `MCP 服务器 ${name} 接入失败：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
    }
  });
  return sessions;
}

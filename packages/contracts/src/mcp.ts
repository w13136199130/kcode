import { z } from "zod";
import { PluginName } from "./plugin-manifest.js";

/** MCP 服务器的接入配置（stdio 传输：独立进程，天然与宿主隔离） */
export const McpServerConfig = z.object({
  name: PluginName,
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfig>;

/** 用户级 MCP 配置文件（~/.kcode/mcp.json）：{ "servers": [...] } */
export const McpServersFile = z
  .object({
    servers: z.array(McpServerConfig).default([]),
  })
  .strict();
export type McpServersFile = z.infer<typeof McpServersFile>;

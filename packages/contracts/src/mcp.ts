import { z } from "zod";
import { PluginName } from "./plugin-manifest.js";

/**
 * MCP 服务器的接入配置（B5 三传输）：
 * stdio = 独立子进程（默认，天然隔离）；http = Streamable HTTP；sse = 旧式 SSE。
 * timeoutMs 对 callTool/listTools 生效（挂死的服务器不再拖住整轮，默认 60s）。
 */
export const McpServerConfig = z
  .object({
    name: PluginName,
    transport: z.enum(["stdio", "http", "sse"]).default("stdio"),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.transport === "stdio" && (cfg.command === undefined || cfg.command === "")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "stdio 传输需要 command" });
    }
    if ((cfg.transport === "http" || cfg.transport === "sse") && cfg.url === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${cfg.transport} 传输需要 url` });
    }
  });
export type McpServerConfig = z.infer<typeof McpServerConfig>;

/** 用户级 MCP 配置文件（~/.kcode/mcp.json）：{ "servers": [...] } */
export const McpServersFile = z
  .object({
    servers: z.array(McpServerConfig).default([]),
  })
  .strict();
export type McpServersFile = z.infer<typeof McpServersFile>;

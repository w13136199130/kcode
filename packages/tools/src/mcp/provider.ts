import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig, Tool, ToolOutput } from "@kcode/contracts";

/** 连接与工具列举超时：挂死的服务器不该拖住会话启动 */
const CONNECT_TIMEOUT_MS = 10_000;
/** callTool 默认超时（可被 config.timeoutMs 覆盖）：挂死拖轮是生产隐患（B5） */
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
/** 3-14：图片内容落盘目录（与 extract 同一"图片路径"通道） */
const IMAGE_DIR = join(tmpdir(), "kcode-mcp-images");
const MAX_IMAGES = 3;
const STRUCTURED_LIMIT = 4_000;
const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export interface McpSession {
  /** 服务器名（/mcp 状态展示用） */
  name: string;
  transport: "stdio" | "http" | "sse";
  /** 接入成功后暴露的工具，命名为 mcp__<服务器>__<工具>（与权限规则命名空间一致） */
  tools: Tool[];
  /** 断开连接并结束子进程 */
  close(): Promise<void>;
}

/** 超时竞速：到点拒绝——调用方把超时转为错误结果，不悬挂整轮。3-14：signal 中断立即拒绝。 */
export async function withMcpTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const racers: Promise<T>[] = [
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)}s）`)), ms);
      }),
    ];
    if (signal !== undefined) {
      racers.push(
        new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new Error(`${label}已取消`));
            return;
          }
          onAbort = () => reject(new Error(`${label}已取消`));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      );
    }
    return await Promise.race(racers);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

function defaultTransport(config: McpServerConfig): Transport {
  if (config.transport === "http" || config.transport === "sse") {
    const url = new URL(config.url ?? "");
    // 3-14：headers 透传（远端 token）；stdio 无请求头概念
    const opts = config.headers !== undefined ? { requestInit: { headers: config.headers } } : undefined;
    return config.transport === "http"
      ? new StreamableHTTPClientTransport(url, opts)
      : new SSEClientTransport(url, opts);
  }
  return new StdioClientTransport({
    command: config.command ?? "",
    args: config.args,
    ...(config.env !== undefined ? { env: config.env } : {}),
  });
}

/** 工具内容块的宽松形态（text/image/resource/resource_link） */
interface LooseContent {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
  uri?: string;
  name?: string;
}

interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
}

interface CallResult {
  content?: LooseContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

function isTransportError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /closed|disconnect|not connected|ECONNRESET|ECONNREFUSED|EPIPE|socket|transport/i.test(message);
}

/** 3-14：图片内容落盘（base64 → tmp 文件），复用 loop 的 imagePaths 通道供视觉模型查看 */
async function materializeImage(block: LooseContent): Promise<string | undefined> {
  const ext = block.mimeType !== undefined ? IMAGE_EXT[block.mimeType] : undefined;
  if (ext === undefined || typeof block.data !== "string" || block.data === "") {
    return undefined;
  }
  try {
    await mkdir(IMAGE_DIR, { recursive: true });
    const hash = createHash("sha256").update(block.data).digest("hex").slice(0, 16);
    const path = join(IMAGE_DIR, `${hash}.${ext}`);
    await writeFile(path, Buffer.from(block.data, "base64"));
    return path;
  } catch {
    return undefined;
  }
}

/** 3-14：content 数组 → 文本 + 图片路径（resource/resource_link 也转文本） */
async function renderContent(
  content: LooseContent[],
  label: string,
): Promise<{ text: string; imagePaths: string[] }> {
  const parts: string[] = [];
  const imagePaths: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "image") {
      if (imagePaths.length < MAX_IMAGES) {
        const path = await materializeImage(block);
        if (path !== undefined) {
          imagePaths.push(path);
          parts.push(`[图片 ${block.mimeType ?? "image"}：${path}]`);
          continue;
        }
      }
      parts.push(`[图片 ${block.mimeType ?? "image"}（未能保存或超出 ${MAX_IMAGES} 张上限）]`);
      continue;
    }
    if (block.type === "resource") {
      const resource = block.resource;
      if (resource?.text !== undefined) {
        parts.push(`[资源 ${resource.uri ?? ""}]\n${resource.text}`);
      } else {
        parts.push(`[资源 ${resource?.uri ?? ""}（${resource?.mimeType ?? "binary"}）]`);
      }
      continue;
    }
    if (block.type === "resource_link") {
      parts.push(`[资源链接 ${block.name ?? ""}：${block.uri ?? ""}]`);
      continue;
    }
    parts.push(`[${block.type ?? "未知内容"} ${label}]`);
  }
  return { text: parts.join("\n"), imagePaths };
}

/**
 * 连接一个 MCP 服务器（独立进程/HTTP）：
 * - 3-14：annotations.readOnlyHint → definition.readOnly + plan 档放行；
 * - signal 透传：Esc 立即结束等待；
 * - 图片落盘走 imagePaths；structuredContent 附加为文本；
 * - 传输层断开自动重连并重试一次（仅连接类错误，避免副作用重放）。
 */
export async function connectMcpServer(
  config: McpServerConfig,
  transportFactory?: () => Transport,
): Promise<McpSession> {
  const makeClient = async (): Promise<Client> => {
    const client = new Client({ name: "kcode", version: "0.1.0" });
    const transport = transportFactory !== undefined ? transportFactory() : defaultTransport(config);
    await withMcpTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `MCP ${config.name} 连接`);
    return client;
  };

  let client = await makeClient();
  let closed = false;
  let reconnecting: Promise<void> | null = null;

  const reconnect = async (): Promise<void> => {
    if (closed) {
      throw new Error(`MCP ${config.name} 已关闭`);
    }
    reconnecting ??= (async () => {
      try {
        await client.close();
      } catch {
        // 旧连接已断：忽略关闭错误
      }
      client = await makeClient();
    })();
    try {
      await reconnecting;
    } finally {
      reconnecting = null;
    }
  };

  const listed = (await withMcpTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `MCP ${config.name} 工具列举`)) as unknown as {
    tools?: ListedTool[];
  };

  const tools: Tool[] = (listed.tools ?? []).map((tool) => {
    const readOnly = tool.annotations?.readOnlyHint === true;
    return {
      definition: {
        name: `mcp__${config.name}__${tool.name}`,
        description: tool.description ?? `MCP 工具 ${config.name}/${tool.name}`,
        parameters:
          (tool.inputSchema as { type?: string })?.type === "object"
            ? (tool.inputSchema as Record<string, unknown>)
            : { type: "object" },
        readOnly,
        // 3-14：服务器声明只读 → plan 档放行；未声明维持默认 ask / plan deny
        permission: readOnly ? { default: "ask", plan: "allow" } : { default: "ask" },
      },
      async execute(input, ctx): Promise<ToolOutput> {
        const call = (): Promise<CallResult> =>
          client.callTool(
            { name: tool.name, arguments: (input ?? {}) as Record<string, unknown> },
            undefined,
            ctx.signal !== undefined ? { signal: ctx.signal } : undefined,
          ) as unknown as Promise<CallResult>;
        let result: CallResult;
        try {
          result = await withMcpTimeout(
            call(),
            config.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
            `MCP ${config.name}.${tool.name} `,
            ctx.signal,
          );
        } catch (err) {
          // 用户中断不重连；连接类错误重连一次后重试（超时/业务错误不重放，避免副作用）
          if (ctx.signal?.aborted === true || !isTransportError(err)) {
            throw err;
          }
          await reconnect();
          result = await withMcpTimeout(
            call(),
            config.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
            `MCP ${config.name}.${tool.name} `,
            ctx.signal,
          );
        }
        const rendered = await renderContent(result.content ?? [], `${config.name}/${tool.name}`);
        if (result.structuredContent !== undefined) {
          const json = JSON.stringify(result.structuredContent);
          rendered.text += `\n[结构化结果]\n${json.length > STRUCTURED_LIMIT ? `${json.slice(0, STRUCTURED_LIMIT)}…` : json}`;
        }
        const output = rendered.text;
        const images = rendered.imagePaths.length > 0 ? { imagePaths: rendered.imagePaths } : {};
        if (result.isError === true) {
          return { ok: false, output, error: output !== "" ? output : "MCP 工具执行失败", ...images };
        }
        return { ok: true, output, ...images };
      },
    };
  });

  return {
    name: config.name,
    transport: config.transport,
    tools,
    close: async () => {
      closed = true;
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

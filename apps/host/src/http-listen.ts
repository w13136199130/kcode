import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { HostFrame } from "@kcode/contracts";

/**
 * S2-4：host 可选 HTTP 监听（--listen）——同一套 RPC dispatch 的第二通道。
 * opencode 多端模式的底座：TUI/桌面（stdio MessagePort）之外，web/IDE/ACP 客户端
 * 经 HTTP 驱动同一会话；4-09 ACP server 未来复用同一 request() 入口。
 *
 * 安全边界：默认关闭；只绑 127.0.0.1；Bearer token（KCODE_HOST_TOKEN 或自动生成
 * 打到 stderr，由拉起方捕获）；SSE 因 EventSource 不能带 header，允许 ?token= 查询参数。
 */
export interface HttpListener {
  port: number;
  close(): Promise<void>;
  broadcast(frame: HostFrame): void;
}

export interface HttpListenerServer {
  /** 进程内 RPC 入口（HostServer.request —— 同 #dispatch，不经帧层/idempotency 缓存） */
  request(method: string, params?: unknown): Promise<unknown>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function authorized(req: IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers["authorization"];
  if (header === `Bearer ${token}`) return true;
  return url.searchParams.get("token") === token;
}

export async function startHttpListener(opts: {
  server: HttpListenerServer;
  port?: number;
  token: string;
}): Promise<HttpListener> {
  const sseClients = new Set<ServerResponse>();
  const httpServer: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (!authorized(req, url, opts.token)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(":ok\n\n");
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }
      if (req.method === "POST" && url.pathname === "/rpc") {
        let body: { method?: unknown; params?: unknown };
        try {
          body = JSON.parse(await readBody(req)) as { method?: unknown; params?: unknown };
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "body 不是合法 JSON" }));
          return;
        }
        if (typeof body.method !== "string" || body.method === "") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "method 不能为空" }));
          return;
        }
        try {
          const result = await opts.server.request(body.method, body.params);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, ...(result !== undefined ? { result } : {}) }));
        } catch (err) {
          res.writeHead(200, { "content-type": "application/json" }); // RPC 语义：业务错误也是 200
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port ?? 0, "127.0.0.1", () => {
      const address = httpServer.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  return {
    port,
    async close(): Promise<void> {
      for (const res of sseClients) res.end();
      sseClients.clear();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
    broadcast(frame: HostFrame): void {
      const data = `data: ${JSON.stringify(frame)}\n\n`;
      for (const res of sseClients) res.write(data);
    },
  };
}

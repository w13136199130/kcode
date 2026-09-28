import { readFileSync, existsSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";
import { relayConnection } from "./relay.js";
import { resolveToken, isLoopback, verifyToken } from "./token.js";

/**
 * kcode Web 中继服务器（N3-3）：
 * - HTTP：健康检查 + 元信息
 * - WebSocket：透传宿主协议（浏览器 ↔ 宿主端到端，中继不解析协议帧）
 * - 安全：默认 127.0.0.1 监听 + 启动时生成一次性令牌；非 loopback 时 TLS + 令牌强制
 *
 * 启动：KCODE_HOME=~/.kcode pnpm --filter @kcode/server start
 * 浏览器打开：http://localhost:7300?token=<启动时打印的令牌>
 */

const PORT = Number(process.env["KCODE_PORT"] ?? 7300);
const HOST = process.env["KCODE_HOST"] ?? "127.0.0.1";
const KCODE_HOME = process.env["KCODE_HOME"] ?? join(homedir(), ".kcode");

// TLS（非 loopback 时强制）
const TLS_CERT = process.env["KCODE_TLS_CERT"];
const TLS_KEY = process.env["KCODE_TLS_KEY"];

// 令牌
const token = resolveToken(HOST);

// 宿主入口（开发态 tsx 加载 .ts；发行态用打包后 .mjs）
const hostBin = resolve(import.meta.dirname, "../../../apps/host/src/main.ts");
// tsx 解析：从本包 package.json 位置 resolve（pnpm 布局下 node_modules 在各包目录内）
const { createRequire } = await import("node:module");
const { pathToFileURL } = await import("node:url");
const selfReq = createRequire(resolve(import.meta.dirname, "../package.json"));
let tsxPath: string | null = null;
try {
  tsxPath = selfReq.resolve("tsx");
} catch {
  tsxPath = null; // 发行态：宿主已是 .mjs，不需要 tsx
}

if (!existsSync(hostBin)) {
  console.error(`✗ 宿主入口不存在：${hostBin}`);
  process.exit(1);
}

// 安全检查：非 loopback 必须有 TLS + 显式令牌（fail-closed）
const loopback = isLoopback(HOST);
if (!loopback) {
  if (TLS_CERT === undefined || TLS_KEY === undefined) {
    console.error("✗ 非 loopback 监听必须配置 TLS（KCODE_TLS_CERT + KCODE_TLS_KEY）——fail-closed");
    process.exit(1);
  }
  if (process.env["KCODE_TOKEN"] === undefined) {
    console.error("✗ 非 loopback 监听必须显式设置 KCODE_TOKEN——fail-closed");
    process.exit(1);
  }
}

// HTTP 路由
const app = new Hono();
app.get("/", (c) => c.json({ name: "kcode-server", version: "0.1.0", protocol: "v1" }));
app.get("/health", (c) => c.json({ ok: true }));

// HTTP(S) 服务器
const createServer = (): Server => {
  if (TLS_CERT !== undefined && TLS_KEY !== undefined) {
    return createHttpsServer({
      cert: readFileSync(TLS_CERT),
      key: readFileSync(TLS_KEY),
    });
  }
  return createHttpServer();
};

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST, createServer }, (info) => {
  const scheme = TLS_CERT !== undefined ? "https" : "http";
  console.log(`✓ kcode 中继服务器已启动`);
  console.log(`  地址：${scheme}://${info.address}:${info.port}`);
  console.log(`  宿主：${hostBin}${tsxPath !== null ? "（tsx 开发态）" : ""}`);
  console.log(`  令牌：${token}`);
  console.log(`  WebSocket：ws${TLS_CERT !== undefined ? "s" : ""}://${info.address}:${info.port}/ws?token=${token}`);
  if (loopback) {
    console.log(`  监听：${HOST}（loopback）`);
  } else {
    console.log(`  监听：${HOST}（非 loopback：TLS + 令牌强制）`);
  }
});

// 端口占用时给出可操作提示，而非裸栈
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`✗ 端口 ${PORT} 已被占用——先杀残留进程再启动：`);
    console.error(`  Windows:  netstat -ano | findstr :${PORT}  →  taskkill /F /PID <PID>`);
    console.error(`  或者换个端口：KCODE_PORT=${PORT + 1} pnpm --filter @kcode/server start`);
  } else {
    console.error(`✗ 服务器启动失败：${err.message}`);
  }
  process.exit(1);
});

// WebSocket 升级
const wss = new WebSocketServer({ server: server as unknown as import("node:http").Server, path: "/ws" });
wss.on("connection", (ws: WebSocket, request) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const err = verifyToken(url, token);
  if (err !== null) {
    ws.send(JSON.stringify({ kind: "res", id: "__auth__", ok: false, error: err }));
    ws.close();
    return;
  }
  console.log(`[ws] 客户端连接（${request.socket.remoteAddress}）——spawn 宿主`);
  relayConnection(ws, { hostBin, kcodeHome: KCODE_HOME, cwd: process.cwd(), tsxPath });
});

// 优雅退出
process.on("SIGTERM", () => {
  console.log("[server] SIGTERM → 关闭");
  wss.close();
  server.close();
  process.exit(0);
});
process.on("SIGINT", () => {
  console.log("[server] SIGINT → 关闭");
  wss.close();
  server.close();
  process.exit(0);
});

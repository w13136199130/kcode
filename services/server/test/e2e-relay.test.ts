import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * N3-3 E2E 测试：中继服务器 → 宿主进程 → 协议帧往返
 * 覆盖：令牌认证、WebSocket 连接、宿主 spawn、session/create
 */

const SERVER_BIN = resolve(import.meta.dirname, "../src/index.ts");
const TOKEN = "e2e-test-token";
const PORT = 7301;

let serverProc: ReturnType<typeof spawn>;
let homeDir: string;
let ws: WebSocket;

beforeAll(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "kcode-relay-test-"));
  await mkdir(join(homeDir, "cli", "sessions"), { recursive: true });
  await writeFile(
    join(homeDir, "config.json"),
    JSON.stringify({ models: { default: "test/echo", providers: { test: { type: "openai-compatible", baseURL: "http://127.0.0.1:9/v1" } } } }),
  );
  // 启动中继服务器（直接用 tsx loader，不走 npx）
  const req = createRequire(resolve(import.meta.dirname, "../package.json"));
  const tsxUrl = pathToFileURL(req.resolve("tsx")).href;
  console.log("[e2e] spawning:", process.execPath, "--import", tsxUrl.slice(0, 60) + "…", SERVER_BIN.slice(-30));
  serverProc = spawn(process.execPath, ["--import", tsxUrl, SERVER_BIN], {
    env: { ...process.env, KCODE_HOME: homeDir, KCODE_TOKEN: TOKEN, KCODE_PORT: String(PORT) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const serverLog: string[] = [];
  serverProc.stdout?.on("data", (d) => { serverLog.push(d.toString()); });
  serverProc.stderr?.on("data", (d) => { serverLog.push(d.toString()); });
  serverProc.on("exit", (code, signal) => { console.error("[e2e] server exited:", code, signal); });

  // 等服务器端口可连（轮询 TCP，不是 WebSocket）
  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    const exitCode = serverProc.exitCode;
    if (exitCode !== null) {
      console.error("[e2e] server died (exit " + exitCode + "):", serverLog.join("").slice(0, 500));
      throw new Error("中继服务器启动失败（见上方日志）");
    }
    try {
      const net = await import("node:net");
      await new Promise<void>((r) => {
        const s = net.connect(PORT, "127.0.0.1", () => { s.destroy(); ready = true; r(); });
        s.on("error", () => r());
      });
      if (!ready) { await new Promise((r) => setTimeout(r, 500)); }
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!ready) {
    console.error("[e2e] server startup log:", serverLog.join("").slice(0, 500));
    throw new Error("中继服务器 20s 内未就绪");
  }
  console.log("[e2e] server ready on port", PORT);
}, 30_000);

afterAll(async () => {
  ws?.close();
  serverProc?.kill();
  await rm(homeDir, { recursive: true, force: true }).catch(() => {});
});

function connectWs(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
    w.on("open", () => resolve(w));
    w.on("error", reject);
    setTimeout(() => reject(new Error("连接超时")), 10_000);
  });
}

function sendFrame(w: WebSocket, frame: unknown): void {
  w.send(JSON.stringify(frame));
}

function waitForFrame(w: WebSocket, pred: (f: Record<string, unknown>) => boolean, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等帧超时")), timeoutMs);
    const handler = (data: WebSocket.RawData): void => {
      const f = JSON.parse(data.toString()) as Record<string, unknown>;
      if (pred(f)) {
        clearTimeout(timer);
        w.off("message", handler);
        resolve(f);
      }
    };
    w.on("message", handler);
  });
}

describe("N3-3 中继服务器 E2E", () => {
  it("错误令牌被拒绝", async () => {
    const bad = await connectWs("wrong-token");
    const res = await waitForFrame(bad, (f) => f.kind === "res" && f.id === "__auth__");
    expect(res.ok).toBe(false);
    bad.close();
  }, 15_000);

  it("正确令牌 → 宿主 spawn → session/create → epoch ≥ 1", async () => {
    ws = await connectWs(TOKEN);
    // 握手
    sendFrame(ws, { kind: "hello", hello: { major: 1, minor: 0, capabilities: [] } });
    // 等宿主 ready
    const ready = await waitForFrame(ws, (f) => f.kind === "ev" && (f.event as { type?: string })?.type === "ready");
    expect(ready).toBeDefined();
    // 创建会话
    sendFrame(ws, { kind: "req", id: "r1", method: "session/create", params: { model: "test/echo", cwd: "/tmp" } });
    const res = await waitForFrame(ws, (f) => f.kind === "res" && f.id === "r1", 30_000);
    expect(res.ok).toBe(true);
    const result = res.result as { sessionId: string; epoch: number };
    expect(result.sessionId).toMatch(/^sess_/);
    expect(result.epoch).toBeGreaterThanOrEqual(1);
  }, 45_000);
});

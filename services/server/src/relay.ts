import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { WebSocket } from "ws";

/**
 * 会话中继（N3-3 核心）：WebSocket ↔ 宿主 stdio 的透明管道。
 * 每个浏览器 WebSocket 连接 spawn 一个宿主进程（注 D：每会话一进程）。
 * 协议帧不做解释——版本协商与方法路由在浏览器 ↔ 宿主之间端到端完成，
 * 中继只透传 JSON-Line + 管理生命周期（断连即杀宿主 → fail-closed）。
 */
export interface RelayOptions {
  hostBin: string;
  kcodeHome: string;
  cwd: string;
  /** tsx 路径（开发态加载 .ts 宿主入口；发行态传 null 用 node 直跑 .mjs） */
  tsxPath: string | null;
}

export function relayConnection(ws: WebSocket, opts: RelayOptions): void {
  const exec = opts.tsxPath !== null
    ? [process.execPath, "--import", pathToFileURL(opts.tsxPath).href]
    : [process.execPath];
  const proc: ChildProcess = spawn(exec[0]!, [...exec.slice(1), opts.hostBin], {
    cwd: opts.cwd,
    env: { ...process.env, KCODE_HOME: opts.kcodeHome },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdin = proc.stdin as NodeJS.WritableStream;
  const stdout = proc.stdout as NodeJS.ReadableStream;

  // 浏览器 → 宿主（逐帧透传，不解析）
  ws.on("message", (data) => {
    const text = data.toString();
    if (text.trim() !== "") {
      stdin.write(`${text}\n`);
    }
  });

  // 宿主 → 浏览器（逐行透传）
  const rl = createInterface({ input: stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (ws.readyState === ws.OPEN && line.trim() !== "") {
      ws.send(line);
    }
  });

  // 宿主 stderr → 服务端日志（诊断用，不进协议流）
  const stderr = proc.stderr as NodeJS.ReadableStream;
  stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text !== "") {
      console.error(`[host:${proc.pid}] ${text}`);
    }
  });

  // 生命周期：断连 → 杀宿主（fail-closed，注 A）
  ws.on("close", () => {
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 2000).unref();
  });
  ws.on("error", () => {
    proc.kill("SIGTERM");
  });

  // 宿主退出 → 通知浏览器并关闭连接
  proc.on("exit", (code, signal) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ kind: "ev", event: { type: "host/closing", reason: `宿主进程退出（code=${code} signal=${signal}）` } }));
      ws.close();
    }
  });
  proc.on("error", (err) => {
    console.error(`[relay] 宿主启动失败: ${err.message}`);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ kind: "res", id: "__spawn__", ok: false, error: `宿主启动失败: ${err.message}` }));
      ws.close();
    }
  });
}

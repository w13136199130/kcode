import { PROTOCOL_MAJOR, PROTOCOL_MINOR, ClientFrame, type HostFrame } from "@kcode/contracts";
import { HostServer } from "./server.js";

/**
 * 宿主 utilityProcess 入口（N3-4 M1，§8.4g）：main 经 parentPort 转交 MessagePort，
 * 协议帧同 host-protocol（一消息一 JSON 帧）。attach/detach 一等操作——
 * renderer reload 只重挂新端口，host 与会话不动（zcode desktopWindowLifecycle 实测教训）。
 * 全部端口关闭 → fail-closed 结算未决 ask → 退出（同 stdio 入口的 stdin-close 语义）。
 */

/** utilityProcess 环境的最小端口形状（避免 host 包引入 electron 类型依赖） */
interface PortLike {
  postMessage(message: string): void;
  start(): void;
  on(event: "message", listener: (ev: { data: unknown }) => void): void;
  on(event: "close", listener: () => void): void;
}
interface ParentPortLike {
  on(event: "message", listener: (ev: { ports: PortLike[] }) => void): void;
}

const parentPort = (process as { parentPort?: ParentPortLike }).parentPort;
if (parentPort === undefined) {
  process.stderr.write("[host-port] 必须以 utilityProcess 方式启动（无 parentPort）\n");
  process.exit(1);
}

const ports = new Set<PortLike>();
/**
 * 请求按连接命名空间化：HostServer 的 res/幂等缓存按帧 id 全局键控，而 renderer
 * 每次加载都从 desktop-1 重新计数——reload 后新旧连接同 id 相撞，新请求会直接
 * 吐出旧连接的缓存响应（实测：workspace/status 拿到旧 false，信任横幅复活；
 * session/replay 拿到别的载荷报 not-iterable）。故入站 req 的 id 加 `${nonce}:`
 * 前缀再进 server，出站 res 剥前缀并单播回所属端口；归属端口已关的响应丢弃。
 * hello/ev 仍广播（事件各端自按 sessionId 过滤）。
 */
let connNonce = 0;
const ownerByScopedId = new Map<string, { port: PortLike; id: string }>();
/** reload 的端口交接间隙：旧 port 先关、新 port 稍后 attach，不能立即判死 */
const PORT_CLOSE_GRACE_MS = 2_000;
let closeTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

function scheduleClientDisconnectShutdown(): void {
  if (shuttingDown || closeTimer !== null) return;
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (ports.size > 0 || shuttingDown) return;
    shuttingDown = true;
    // 客户端全部断连：fail-closed 结算所有未决交互后退出
    void server.shutdown("client-disconnected").finally(() => process.exit(0));
  }, PORT_CLOSE_GRACE_MS);
}

const server = new HostServer((frame: HostFrame) => {
  if (frame.kind === "res") {
    const owner = ownerByScopedId.get(frame.id);
    ownerByScopedId.delete(frame.id);
    if (owner !== undefined && ports.has(owner.port)) {
      const { id, ...rest } = frame;
      owner.port.postMessage(JSON.stringify({ ...rest, id: owner.id }));
    }
    return;
  }
  const line = JSON.stringify(frame);
  for (const port of ports) {
    port.postMessage(line);
  }
});
void server.start();

function pump(port: PortLike): void {
  const nonce = ++connNonce;
  port.on("message", (ev) => {
    const raw = typeof ev.data === "string" ? ev.data.trim() : "";
    if (raw === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      process.stderr.write(`[host-port] 非 JSON 消息：${raw.slice(0, 80)}\n`);
      return;
    }
    const frame = ClientFrame.safeParse(parsed);
    if (!frame.success) {
      process.stderr.write(`[host-port] 帧不合法：${frame.error.message.slice(0, 120)}\n`);
      return;
    }
    if (frame.data.kind === "req") {
      const scopedId = `${nonce}:${frame.data.id}`;
      ownerByScopedId.set(scopedId, { port, id: frame.data.id });
      void server.handleFrame({ ...frame.data, id: scopedId }).catch((err) => {
        process.stderr.write(`[host-port] 帧处理异常：${err instanceof Error ? err.stack : String(err)}\n`);
      });
      return;
    }
    void server.handleFrame(frame.data).catch((err) => {
      process.stderr.write(`[host-port] 帧处理异常：${err instanceof Error ? err.stack : String(err)}\n`);
    });
  });
  port.on("close", () => {
    ports.delete(port);
    for (const [scopedId, owner] of ownerByScopedId) {
      if (owner.port === port) ownerByScopedId.delete(scopedId);
    }
    if (ports.size === 0) scheduleClientDisconnectShutdown();
  });
  port.start();
  // 每个新挂载的端口都要走一遍握手（host 回 hello + ready）
  void server.handleFrame({
    kind: "hello",
    hello: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR, capabilities: ["session", "queue", "ask", "plan"] },
  });
}

parentPort.on("message", (ev) => {
  // reload 新端口到达：取消上一次“全部断连”的退出倒计时
  if (closeTimer !== null) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  for (const port of ev.ports) {
    ports.add(port);
    pump(port);
  }
});

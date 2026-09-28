import { createInterface } from "node:readline";
import { PROTOCOL_MAJOR, PROTOCOL_MINOR, ClientFrame } from "@kcode/contracts";
import { HostServer } from "./server.js";

/**
 * 宿主进程入口（N3-1，注 A/D：每会话一进程；排空权威在宿主）：
 * - stdin/stdout 走 JSON-Line RPC；stderr 只归诊断日志（不污染协议流）；
 * - 握手校验主版本——不一致回错并退出（fail-fast，不静默错配）；
 * - 客户端断连（stdin 关闭）→ 所有未决 ask 按 deny 结算（fail-closed）→ 进程退出。
 */
const server = new HostServer((frame) => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
});
process.stdout.on("error", () => {
  process.exit(0); // 客户端断了：EPIPE 不必刷栈
});

// 对方握手
server.handleFrame({
  kind: "hello",
  hello: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR, capabilities: ["session", "queue", "ask"] },
});

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const text = line.trim();
  if (text === "") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    process.stderr.write(`[host] 非 JSON 行：${text.slice(0, 80)}\n`);
    return;
  }
  const frame = ClientFrame.safeParse(parsed);
  if (!frame.success) {
    process.stderr.write(`[host] 帧不合法：${frame.error.message.slice(0, 120)}\n`);
    return;
  }
  void server.handleFrame(frame.data).catch((err) => {
    process.stderr.write(`[host] 帧处理异常：${err instanceof Error ? err.stack : String(err)}\n`);
  });
});
rl.on("close", () => {
  // 客户端断连：fail-closed 结算所有未决交互，然后退出
  void server.shutdown("client-disconnected").finally(() => process.exit(0));
});

import { connect } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_VERSION,
  type AskPreviewPayload,
  type ServerMessage as ServerMessageType,
} from "@kcode/contracts";

/** 与 daemon 入口约定一致的本地通道地址 */
export function daemonPipePath(): string {
  if (process.platform === "win32") {
    const user = process.env["USERNAME"] ?? process.env["USER"] ?? "default";
    return `\\\\.\\pipe\\kcode-${Buffer.from(user).toString("hex").slice(0, 12)}`;
  }
  return join(homedir(), ".kcode", "daemon.sock");
}

export interface DaemonClientOptions {
  pipePath: string;
  token: string;
}

/**
 * daemon 协议客户端：NDJSON 收发，按 id 关联请求响应；
 * 通知（event/delta/notice/ask/question/run_done）通过回调分发。
 */
export class DaemonClient {
  readonly #socket: import("node:net").Socket;
  #buffer = "";
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (m: ServerMessageType) => void; reject: (e: Error) => void }>();
  readonly #listeners = {
    event: new Set<(sessionId: string, event: ServerMessageType) => void>(),
    delta: new Set<(sessionId: string, text: string, channel: "text" | "reasoning") => void>(),
    notice: new Set<(message: string) => void>(),
    ask: new Set<(callId: string, tool: string, args: unknown, preview?: AskPreviewPayload) => void>(),
    question: new Set<(questionId: string, question: ServerMessageType) => void>(),
    runDone: new Set<(sessionId: string, turns: number, toolCalls: number) => void>(),
    close: new Set<() => void>(),
  };

  private constructor(socket: import("node:net").Socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let index = this.#buffer.indexOf("\n");
      while (index !== -1) {
        const line = this.#buffer.slice(0, index).trim();
        this.#buffer = this.#buffer.slice(index + 1);
        if (line !== "") {
          this.#dispatch(JSON.parse(line) as ServerMessageType);
        }
        index = this.#buffer.indexOf("\n");
      }
    });
    socket.on("close", () => {
      // 未决请求全部结算：对端 destroy 后响应可能被丢弃，悬挂会让上层重连逻辑失效
      for (const waiter of this.#pending.values()) {
        waiter.reject(new Error("连接已关闭（daemon 侧断开）"));
      }
      this.#pending.clear();
      for (const listener of this.#listeners.close) {
        listener();
      }
    });
  }

  /** 连接并完成 token 鉴权握手；协议版本不一致视为过旧 daemon */
  static async open(options: DaemonClientOptions): Promise<DaemonClient> {
    const socket = await new Promise<import("node:net").Socket>((resolvePromise, reject) => {
      const s = connect(options.pipePath, () => {
        resolvePromise(s);
      });
      s.once("error", reject);
    });
    const client = new DaemonClient(socket);
    try {
      const pass = process.env["KCODE_KEYCHAIN_PASSPHRASE"] ?? "";
      const hello = await client.request({
        method: "hello",
        token: options.token,
        protocolVersion: PROTOCOL_VERSION,
        passphraseSet: pass !== "",
      });
      // 旧 daemon 的 hello_ok 不带 protocolVersion → 视为过旧
      if (hello.kind !== "hello_ok" || hello.protocolVersion !== PROTOCOL_VERSION) {
        const detail =
          hello.kind === "hello_ok"
            ? `daemon v${hello.protocolVersion ?? "未知"}`
            : hello.kind === "error"
              ? hello.message
              : hello.kind;
        throw new Error(
          hello.kind === "error" && hello.message.includes("环境不匹配")
            ? hello.message
            : `守护进程协议版本过旧（需 v${PROTOCOL_VERSION}）：${detail}`,
        );
      }
      return client;
    } catch (err) {
      socket.destroy();
      throw err;
    }
  }

  #dispatch(message: ServerMessageType): void {
    if ("id" in message && message.id !== undefined && this.#pending.has(message.id)) {
      const waiter = this.#pending.get(message.id)!;
      this.#pending.delete(message.id);
      if (message.kind === "error") {
        waiter.reject(new Error(message.message));
      } else {
        waiter.resolve(message);
      }
      return;
    }
    switch (message.kind) {
      case "event":
        for (const l of this.#listeners.event) {
          l(message.sessionId, message.event as unknown as ServerMessageType);
        }
        return;
      case "delta":
        for (const l of this.#listeners.delta) {
          l(message.sessionId, message.text, message.channel ?? "text");
        }
        return;
      case "notice":
        for (const l of this.#listeners.notice) {
          l(message.message);
        }
        return;
      case "ask":
        for (const l of this.#listeners.ask) {
          l(message.callId, message.tool, message.args, message.preview);
        }
        return;
      case "question":
        for (const l of this.#listeners.question) {
          l(message.questionId, message.question as unknown as ServerMessageType);
        }
        return;
      case "run_done":
        for (const l of this.#listeners.runDone) {
          l(message.sessionId, message.turns, message.toolCalls);
        }
        return;
      default:
        return;
    }
  }

  request(payload: Record<string, unknown>, timeoutMs = 15_000): Promise<ServerMessageType> {
    const id = this.#nextId++;
    return new Promise((resolvePromise, reject) => {
      // 请求必须有界：daemon 丢失/管道断裂时不能让上层永久悬挂
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("守护进程请求超时（daemon 可能已停止响应）"));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolvePromise(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#socket.write(`${JSON.stringify({ ...payload, id })}\n`);
    });
  }

  replyAsk(callId: string, allowed: boolean, scope?: "once" | "session"): void {
    void this.request({
      method: "ask_reply",
      callId,
      allowed,
      ...(scope !== undefined ? { scope } : {}),
    }).catch(() => {
      // daemon 侧等待已超时结算，忽略
    });
  }

  replyQuestion(questionId: string, labels: string[]): void {
    void this.request({ method: "question_reply", questionId, labels }).catch(() => {
      // 同上
    });
  }

  onClose(listener: () => void): () => void {
    this.#listeners.close.add(listener);
    return () => {
      this.#listeners.close.delete(listener);
    };
  }

  onEvent(listener: (sessionId: string, event: ServerMessageType) => void): () => void {
    this.#listeners.event.add(listener);
    return () => {
      this.#listeners.event.delete(listener);
    };
  }

  onDelta(
    listener: (sessionId: string, text: string, channel: "text" | "reasoning") => void,
  ): () => void {
    this.#listeners.delta.add(listener);
    return () => {
      this.#listeners.delta.delete(listener);
    };
  }

  onNotice(listener: (message: string) => void): () => void {
    this.#listeners.notice.add(listener);
    return () => {
      this.#listeners.notice.delete(listener);
    };
  }

  onAsk(
    listener: (callId: string, tool: string, args: unknown, preview?: AskPreviewPayload) => void,
  ): () => void {
    this.#listeners.ask.add(listener);
    return () => {
      this.#listeners.ask.delete(listener);
    };
  }

  onQuestion(listener: (questionId: string, question: ServerMessageType) => void): () => void {
    this.#listeners.question.add(listener);
    return () => {
      this.#listeners.question.delete(listener);
    };
  }

  onRunDone(listener: (sessionId: string, turns: number, toolCalls: number) => void): () => void {
    this.#listeners.runDone.add(listener);
    return () => {
      this.#listeners.runDone.delete(listener);
    };
  }

  close(): void {
    this.#socket.destroy();
  }
}

/** 结束 daemon（按 pidfile 定位）；供外部在环境变化后主动换新 daemon */
export function killDaemonByPidfile(): boolean {
  const pidFile = join(homedir(), ".kcode", "daemon.pid");
  try {
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
      return false;
    }
    process.kill(pid);
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmSync(pidFile, { force: true });
      rmSync(join(homedir(), ".kcode", "daemon.token"), { force: true });
    } catch {
      // 清理失败不影响主流程
    }
  }
}

/** 连接已运行的 daemon；失败时拉起一个新实例并等待就绪 */
export async function ensureDaemon(): Promise<DaemonClient> {
  const pipePath = daemonPipePath();
  const tokenFile = join(homedir(), ".kcode", "daemon.token");

  /** 结束过旧 daemon（killDaemonByPidfile 的本地别名，语义同上） */
  const killStaleDaemon = killDaemonByPidfile;

  const tryConnect = async (): Promise<DaemonClient | "stale" | null> => {
    if (!existsSync(tokenFile)) {
      return null;
    }
    const token = (await readFile(tokenFile, "utf8")).trim();
    if (token === "") {
      return null;
    }
    try {
      return await DaemonClient.open({ pipePath, token });
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes("协议版本过旧") || err.message.includes("环境不匹配"))
      ) {
        return "stale";
      }
      return null;
    }
  };

  let existing = await tryConnect();
  if (existing === "stale") {
    // 版本错配：结束旧 daemon 后重试一次（首次拉新失败则提示人工处理）
    const killed = killStaleDaemon();
    if (killed) {
      await new Promise((r) => setTimeout(r, 1500));
      existing = await tryConnect();
    }
    if (existing === "stale") {
      throw new Error(
        "守护进程协议版本过旧且无法自动结束：请手动结束 kcode daemon 进程（按 pid 或任务管理器）后重试",
      );
    }
  }
  if (existing !== null) {
    return existing;
  }

  // 拉起 daemon（独立进程常驻），等待 token 文件与通道就绪
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const daemonEntry = resolve(cliDir, "..", "..", "..", "apps", "daemon", "src", "main.ts");
  const child = spawn(process.execPath, ["--import", "tsx", daemonEntry], {
    cwd: resolve(cliDir, ".."),
    stdio: "ignore",
    detached: true,
    env: { ...process.env },
    windowsHide: true,
  });
  child.unref();

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const client = await tryConnect();
    if (client !== null && client !== "stale") {
      return client;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("daemon 启动超时：请检查 ~/.kcode 下配置后重试");
}

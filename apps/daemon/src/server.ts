import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ClientRequest,
  type ClientRequest as ClientRequestType,
  type LLMProvider,
  type ServerMessage as ServerMessageType,
} from "@kcode/contracts";
import { composeSession, resolveResumeHistory, trustProject, type ComposedSession } from "./composition.js";

/** ask/question 等待客户端应答的超时：超时按拒绝处理，避免会话悬挂 */
const INTERACTION_TIMEOUT_MS = 5 * 60 * 1000;

export interface DaemonOptions {
  /** 监听地址：Windows 命名管道（\\.\pipe\...）或 Unix socket 路径 */
  pipePath: string;
  /** 本地鉴权令牌：客户端必须在首条 hello 中携带 */
  token: string;
  /** kcode 主目录（会话/技能/钩子等落点，测试可注入） */
  kcodeHomeDir: string;
  /** 模型提供方工厂：按模型引用构建（生产走 providers 路由，测试注入脚本模型） */
  llmFactory: (model: string) => Promise<LLMProvider>;
  daemonVersion: string;
}

export interface DaemonHandle {
  pipePath: string;
  /** 关闭监听并结束全部连接 */
  close(): Promise<void>;
}

interface Connection {
  socket: Socket;
  authed: boolean;
  sessions: Map<string, ComposedSession>;
  /** 等待客户端应答的 ask：callId → resolve */
  pendingAsks: Map<string, (allowed: boolean) => void>;
  /** 等待客户端应答的 question：questionId → resolve */
  pendingQuestions: Map<string, (labels: string[]) => void>;
}

/**
 * 守护进程本地 API 服务器：named pipe / Unix socket 上的 NDJSON 协议。
 * 单连接可承载多个会话；事件、流式增量与交互请求（ask/question）全部推送到该连接。
 */
export function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const connections = new Set<Connection>();

  const server = createServer((socket) => {
    const conn: Connection = {
      socket,
      authed: false,
      sessions: new Map(),
      pendingAsks: new Map(),
      pendingQuestions: new Map(),
    };
    connections.add(conn);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line !== "") {
          handleLine(conn, line).catch(() => {
            // 单条消息处理失败只回错误，不切断连接
          });
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => {
      // 连接断开：未决交互按拒绝结算，会话资源释放
      for (const resolve of conn.pendingAsks.values()) {
        resolve(false);
      }
      for (const resolve of conn.pendingQuestions.values()) {
        resolve([]);
      }
      for (const session of conn.sessions.values()) {
        void session.close();
      }
      connections.delete(conn);
    });
    socket.on("error", () => {
      // 连接异常交由 close 统一清理
    });
  });

  async function handleLine(conn: Connection, line: string): Promise<void> {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      send(conn, { kind: "error", message: "消息不是合法 JSON" });
      return;
    }
    const request = ClientRequest.safeParse(parsedJson);
    if (!request.success) {
      send(conn, { kind: "error", message: `请求不合法: ${request.error.message}` });
      return;
    }
    const message = request.data;

    if (!conn.authed && message.method !== "hello") {
      send(conn, { kind: "error", id: message.id, message: "未鉴权：首条消息必须是 hello" });
      return;
    }

    switch (message.method) {
      case "hello": {
        if (message.token !== options.token) {
          send(conn, { kind: "error", id: message.id, message: "token 不正确" });
          conn.socket.destroy();
          return;
        }
        conn.authed = true;
        send(conn, { kind: "hello_ok", id: message.id, daemonVersion: options.daemonVersion });
        return;
      }
      case "ping": {
        send(conn, { kind: "pong", id: message.id });
        return;
      }
      case "session_create": {
        try {
          const resume =
            message.resumeFrom !== undefined
              ? (await resolveResumeHistory(options.kcodeHomeDir, message.resumeFrom)) ?? undefined
              : undefined;
          const session = await composeSession({
            llm: await options.llmFactory(message.model),
            model: message.model,
            cwd: message.cwd,
            kcodeHomeDir: options.kcodeHomeDir,
            resumeFrom: resume,
            onEvent: (event) => send(conn, { kind: "event", sessionId: session.sessionId, event }),
            onDelta: (text) => send(conn, { kind: "delta", sessionId: session.sessionId, text }),
            onNotice: (text) => send(conn, { kind: "notice", message: text }),
            asker: {
              confirm: (call) =>
                new Promise<boolean>((resolve) => {
                  const timer = setTimeout(() => {
                    conn.pendingAsks.delete(call.callId);
                    resolve(false);
                  }, INTERACTION_TIMEOUT_MS);
                  conn.pendingAsks.set(call.callId, (allowed) => {
                    clearTimeout(timer);
                    resolve(allowed);
                  });
                  send(conn, { kind: "ask", callId: call.callId, tool: call.tool, args: call.args });
                }),
            },
            askUser: {
              ask: (question) =>
                new Promise<string[]>((resolve) => {
                  const questionId = randomUUID();
                  const timer = setTimeout(() => {
                    conn.pendingQuestions.delete(questionId);
                    resolve([]);
                  }, INTERACTION_TIMEOUT_MS);
                  conn.pendingQuestions.set(questionId, (labels) => {
                    clearTimeout(timer);
                    resolve(labels);
                  });
                  send(conn, { kind: "question", questionId, question });
                }),
            },
          });
          conn.sessions.set(session.sessionId, session);
          send(conn, {
            kind: "session_ok",
            id: message.id,
            sessionId: session.sessionId,
            resumedMessages: resume?.length ?? 0,
          });
        } catch (err) {
          send(conn, {
            kind: "error",
            id: message.id,
            message: `会话创建失败: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        return;
      }
      case "session_send": {
        const session = conn.sessions.get(message.sessionId);
        if (session === undefined) {
          send(conn, { kind: "error", id: message.id, message: "会话不存在" });
          return;
        }
        send(conn, { kind: "accepted", id: message.id });
        void session.loop
          .run(message.content, message.images !== undefined ? { images: message.images } : {})
          .then((summary) => {
            send(conn, {
              kind: "run_done",
              sessionId: summary.sessionId,
              turns: summary.turns,
              toolCalls: summary.toolCalls,
            });
          })
          .catch((err) => {
            send(conn, {
              kind: "notice",
              message: `会话执行出错: ${err instanceof Error ? err.message : String(err)}`,
            });
            send(conn, {
              kind: "run_done",
              sessionId: message.sessionId,
              turns: 0,
              toolCalls: 0,
            });
          });
        return;
      }
      case "session_plan": {
        const session = conn.sessions.get(message.sessionId);
        if (session === undefined) {
          send(conn, { kind: "error", id: message.id, message: "会话不存在" });
          return;
        }
        session.setPlanMode(message.on);
        send(conn, { kind: "accepted", id: message.id });
        return;
      }
      case "session_trust": {
        await trustProject(message.cwd, options.kcodeHomeDir);
        send(conn, { kind: "accepted", id: message.id });
        return;
      }
      case "commands_list": {
        const { CommandLibrary } = await import("@kcode/extensions");
        const library = await CommandLibrary.open(
          [
            { dir: join(message.cwd, ".kcode", "commands"), source: "project" },
            { dir: join(options.kcodeHomeDir, "commands"), source: "user" },
          ],
          (text) => send(conn, { kind: "notice", message: text }),
        );
        send(conn, { kind: "commands", id: message.id, commands: library.list() });
        return;
      }
      case "command_expand": {
        const { CommandLibrary } = await import("@kcode/extensions");
        const library = await CommandLibrary.open([
          { dir: join(message.cwd, ".kcode", "commands"), source: "project" },
          { dir: join(options.kcodeHomeDir, "commands"), source: "user" },
        ]);
        const template = await library.expand(message.name, message.args);
        send(conn, { kind: "command_expanded", id: message.id, template });
        return;
      }
      case "ask_reply": {
        conn.pendingAsks.get(message.callId)?.(message.allowed);
        conn.pendingAsks.delete(message.callId);
        return;
      }
      case "question_reply": {
        conn.pendingQuestions.get(message.questionId)?.(message.labels);
        conn.pendingQuestions.delete(message.questionId);
        return;
      }
      default: {
        const exhaustive: never = message;
        send(conn, { kind: "error", message: `未处理的消息: ${JSON.stringify(exhaustive)}` });
      }
    }
  }

  function send(conn: Connection, message: ServerMessageType): void {
    if (!conn.socket.destroyed) {
      conn.socket.write(`${JSON.stringify(message)}\n`);
    }
  }

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(options.pipePath, () => {
      resolvePromise({
        pipePath: options.pipePath,
        close: () =>
          new Promise((resolveClose) => {
            for (const conn of connections) {
              conn.socket.destroy();
            }
            server.close(() => {
              resolveClose();
            });
          }),
      });
    });
  });
}

/** 导出类型供客户端侧共享推断 */
export type { ClientRequestType };

import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ClientRequest,
  PROTOCOL_VERSION,
  type ClientRequest as ClientRequestType,
  type LLMProvider,
  type PermissionAnswer,
  type ServerMessage as ServerMessageType,
} from "@kcode/contracts";
import { buildAskPreview } from "@kcode/tools";
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
  /** 可用模型清单（/model 命令）：默认引用 + providers */
  modelsInfo: () => { default?: string; providers: string[] };
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
  /** 等待客户端应答的 ask：callId → resolve（应答含会话级放行标记） */
  pendingAsks: Map<string, (answer: PermissionAnswer) => void>;
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
        resolve({ allowed: false });
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

  /** 回送错误后延迟关闭：Windows 命名管道「写后立即 end/destroy」会丢弃未冲刷数据 */
function rejectAndClose(conn: Connection, message: ServerMessageType, delayMs = 100): void {
  send(conn, message);
  setTimeout(() => {
    if (!conn.socket.destroyed) {
      conn.socket.destroy();
    }
  }, delayMs);
}

async function handleLine(conn: Connection, line: string): Promise<void> {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      send(conn, { kind: "error", message: "消息不是合法 JSON" });
      return;
    }
    // 解析失败也尽量回带请求 id：客户端的 pending 请求才能结算，而不是悬挂到超时
    const rawId =
      typeof parsedJson === "object" && parsedJson !== null && "id" in parsedJson
        ? (parsedJson as { id?: unknown }).id
        : undefined;
    const replyId = typeof rawId === "number" && Number.isInteger(rawId) && rawId >= 0 ? rawId : undefined;
    const request = ClientRequest.safeParse(parsedJson);
    if (!request.success) {
      send(conn, {
        kind: "error",
        ...(replyId !== undefined ? { id: replyId } : {}),
        message: `请求不合法: ${request.error.message}`,
      });
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
          rejectAndClose(conn, { kind: "error", id: message.id, message: "token 不正确" });
          return;
        }
        // 协议版本不一致直接拒绝：升级后旧客户端不静默错配（PROTOCOL_VERSION 契约）
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          rejectAndClose(conn, {
            kind: "error",
            id: message.id,
            message: `协议版本不一致（客户端 v${message.protocolVersion} / 守护进程 v${PROTOCOL_VERSION}）：请结束旧进程后重试`,
          });
          return;
        }
        // keychain 口令状态不一致 = daemon 由不同环境的终端拉起（环境过期）：
        // 客户端据此自动结束旧 daemon 重拉，避免「设了变量却连着无口令旧进程」的死局
        const daemonHasPass = (process.env["KCODE_KEYCHAIN_PASSPHRASE"] ?? "") !== "";
        if (message.passphraseSet !== undefined && message.passphraseSet !== daemonHasPass) {
          rejectAndClose(conn, {
            kind: "error",
            id: message.id,
            message: "daemon 环境不匹配：keychain 口令状态与客户端不同（旧 daemon 由不同环境的终端拉起），请结束旧 daemon 后重试",
          });
          return;
        }
        conn.authed = true;
        send(conn, {
          kind: "hello_ok",
          id: message.id,
          daemonVersion: options.daemonVersion,
          protocolVersion: PROTOCOL_VERSION,
        });
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
            llmFactory: options.llmFactory,
            model: message.model,
            cwd: message.cwd,
            kcodeHomeDir: options.kcodeHomeDir,
            resumeFrom: resume?.messages,
            resumeUsage: resume?.usage,
            onEvent: (event) => send(conn, { kind: "event", sessionId: session.sessionId, event }),
            onDelta: (text) => send(conn, { kind: "delta", sessionId: session.sessionId, text }),
            onReasoning: (text) =>
              send(conn, { kind: "delta", sessionId: session.sessionId, text, channel: "reasoning" }),
            onNotice: (text) => send(conn, { kind: "notice", message: text }),
            asker: {
              confirm: (call) =>
                new Promise<boolean | PermissionAnswer>((resolve) => {
                  const timer = setTimeout(() => {
                    conn.pendingAsks.delete(call.callId);
                    resolve({ allowed: false });
                  }, INTERACTION_TIMEOUT_MS);
                  conn.pendingAsks.set(call.callId, (answer) => {
                    clearTimeout(timer);
                    resolve(answer);
                  });
                  void (async () => {
                    const preview = await buildAskPreview(call.tool, call.args, {
                      sessionId: call.callId,
                      cwd: message.cwd,
                    });
                    send(conn, {
                      kind: "ask",
                      callId: call.callId,
                      tool: call.tool,
                      args: call.args,
                      ...(preview !== undefined ? { preview } : {}),
                    });
                  })();
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
            planAsker: {
              ask: (plan) =>
                new Promise((resolve) => {
                  const questionId = randomUUID();
                  const timer = setTimeout(() => {
                    conn.pendingQuestions.delete(questionId);
                    resolve("abandon");
                  }, INTERACTION_TIMEOUT_MS);
                  conn.pendingQuestions.set(questionId, (labels) => {
                    clearTimeout(timer);
                    const picked = labels[0] ?? "";
                    resolve(picked === "批准并执行" ? "approved" : picked === "继续研究" ? "revise" : "abandon");
                  });
                  send(conn, {
                    kind: "plan_question",
                    questionId,
                    question: {
                      question: "以上是模型提交的执行计划，是否批准执行？",
                      options: [
                        { label: "批准并执行", description: "切换到执行模式，按计划执行" },
                        { label: "继续研究", description: "留在计划模式，补充调研后重新提交" },
                        { label: "放弃", description: "放弃该计划，等待新指示" },
                      ],
                    },
                    plan,
                  });
                }),
            },
          });
          conn.sessions.set(session.sessionId, session);
          send(conn, {
            kind: "session_ok",
            id: message.id,
            sessionId: session.sessionId,
            resumedMessages: resume?.messages.length ?? 0,
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
      case "session_abort": {
        const session = conn.sessions.get(message.sessionId);
        if (session === undefined) {
          send(conn, { kind: "error", id: message.id, message: "会话不存在" });
          return;
        }
        // 先结算未决交互（按拒绝）：管线正等 ask 应答，不结算会挂到交互超时
        for (const [callId, resolve] of conn.pendingAsks) {
          resolve({ allowed: false });
          conn.pendingAsks.delete(callId);
        }
        for (const [questionId, resolve] of conn.pendingQuestions) {
          resolve([]);
          conn.pendingQuestions.delete(questionId);
        }
        session.abort();
        send(conn, { kind: "accepted", id: message.id });
        return;
      }
      case "session_mode": {
        const session = conn.sessions.get(message.sessionId);
        if (session === undefined) {
          send(conn, { kind: "error", id: message.id, message: "会话不存在" });
          return;
        }
        session.setMode(message.mode);
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
      case "models_list": {
        const info = options.modelsInfo();
        send(conn, {
          kind: "models",
          id: message.id,
          providers: info.providers,
          ...(info.default !== undefined ? { default: info.default } : {}),
        });
        return;
      }
      case "session_set_model": {
        const session = conn.sessions.get(message.sessionId);
        if (session === undefined) {
          send(conn, { kind: "error", id: message.id, message: "会话不存在" });
          return;
        }
        try {
          await session.setModel(message.model);
          send(conn, { kind: "accepted", id: message.id });
        } catch (err) {
          send(conn, {
            kind: "error",
            id: message.id,
            message: `模型切换失败: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        return;
      }
      case "skills_list": {
        const session = conn.sessions.get(message.sessionId);
        if (session === undefined) {
          send(conn, { kind: "error", id: message.id, message: "会话不存在" });
          return;
        }
        send(conn, { kind: "skills", id: message.id, skills: session.listSkills() });
        return;
      }
      case "skill_body": {
        const session = conn.sessions.get(message.sessionId);
        if (session === undefined) {
          send(conn, { kind: "error", id: message.id, message: "会话不存在" });
          return;
        }
        send(conn, {
          kind: "skill_body_ok",
          id: message.id,
          body: await session.skillBody(message.name),
        });
        return;
      }
      case "sessions_list": {
        const { listSessions } = await import("@kcode/runtime");
        const summaries = await listSessions(join(options.kcodeHomeDir, "cli", "sessions"));
        send(conn, {
          kind: "sessions",
          id: message.id,
          sessions: summaries.slice(0, 10).map((s) => ({
            sessionId: s.sessionId,
            preview: s.preview,
            turns: s.turns,
          })),
        });
        return;
      }
      case "permissions_list": {
        const session = conn.sessions.get(message.sessionId);
        if (session === undefined) {
          send(conn, { kind: "error", id: message.id, message: "会话不存在" });
          return;
        }
        send(conn, { kind: "permissions", id: message.id, patterns: await session.listPersistentGrants() });
        return;
      }
      case "permissions_clear": {
        const session = conn.sessions.get(message.sessionId);
        if (session === undefined) {
          send(conn, { kind: "error", id: message.id, message: "会话不存在" });
          return;
        }
        await session.clearPersistentGrants();
        send(conn, { kind: "accepted", id: message.id });
        return;
      }
      case "session_usage": {
        const session = conn.sessions.get(message.sessionId);
        if (session === undefined) {
          send(conn, { kind: "error", id: message.id, message: "会话不存在" });
          return;
        }
        const usage = session.usageSummary();
        send(conn, {
          kind: "usage",
          id: message.id,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          calls: usage.calls,
        });
        return;
      }
      case "session_rewind_points": {
        const session = conn.sessions.get(message.sessionId);
        if (session === undefined) {
          send(conn, { kind: "error", id: message.id, message: "会话不存在" });
          return;
        }
        send(conn, { kind: "rewind_points", id: message.id, points: await session.listRewindPoints() });
        return;
      }
      case "session_rewind": {
        const session = conn.sessions.get(message.sessionId);
        if (session === undefined) {
          send(conn, { kind: "error", id: message.id, message: "会话不存在" });
          return;
        }
        try {
          const result = await session.rewind(message.eventIndex);
          send(conn, { kind: "rewind_ok", id: message.id, ...result });
        } catch (err) {
          send(conn, {
            kind: "error",
            id: message.id,
            message: `回退失败: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        return;
      }
      case "session_compact": {
        const session = conn.sessions.get(message.sessionId);
        if (session === undefined) {
          send(conn, { kind: "error", id: message.id, message: "会话不存在" });
          return;
        }
        try {
          const result = await session.compactNow();
          send(conn, {
            kind: "compact_ok",
            id: message.id,
            dropped: result?.dropped ?? 0,
            summaryChars: result?.summaryChars ?? 0,
          });
        } catch (err) {
          send(conn, {
            kind: "error",
            id: message.id,
            message: `压缩失败: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        return;
      }
      case "session_context": {
        const session = conn.sessions.get(message.sessionId);
        if (session === undefined) {
          send(conn, { kind: "error", id: message.id, message: "会话不存在" });
          return;
        }
        const stats = session.contextStats();
        send(conn, { kind: "context_info", id: message.id, ...stats });
        return;
      }
      case "ask_reply": {
        conn.pendingAsks.get(message.callId)?.({
          allowed: message.allowed,
          ...(message.scope !== undefined ? { scope: message.scope } : {}),
        });
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

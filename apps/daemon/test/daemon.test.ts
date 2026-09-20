import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLLM } from "@kcode/core";
import type { ServerMessage } from "@kcode/contracts";
import { startDaemon, type DaemonHandle } from "../src/server.js";

/**
 * 直接基于 socket 的最小协议客户端：
 * send(request) 等待同 id 响应；通知消息推入 notifications 数组。
 */
class ProtocolClient {
  private socket!: import("node:net").Socket;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (m: ServerMessage) => void; reject: (e: Error) => void }>();
  readonly notifications: ServerMessage[] = [];
  private notificationListeners: (() => void)[] = [];

  async open(pipePath: string): Promise<void> {
    const net = await import("node:net");
    await new Promise<void>((resolvePromise, reject) => {
      this.socket = net.connect(pipePath, () => {
        resolvePromise();
      });
      this.socket.on("error", reject);
    });
    this.socket.setEncoding("utf8");
    // 连接关闭时结算全部 pending：daemon 侧 destroy 后响应可能被丢弃，不能让请求悬挂
    this.socket.on("close", () => {
      for (const waiter of this.pending.values()) {
        waiter.reject(new Error("连接已关闭（daemon 侧断开）"));
      }
      this.pending.clear();
    });
    this.socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf("\n");
      while (index !== -1) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line !== "") {
          const message = JSON.parse(line) as ServerMessage;
          this.dispatch(message);
        }
        index = this.buffer.indexOf("\n");
      }
    });
  }

  private dispatch(message: ServerMessage): void {
    if ("id" in message && message.id !== undefined && this.pending.has(message.id)) {
      const waiter = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.kind === "error") {
        waiter.reject(new Error(message.message));
      } else {
        waiter.resolve(message);
      }
      return;
    }
    this.notifications.push(message);
    for (const listener of this.notificationListeners) {
      listener();
    }
  }

  /** 等待下一条匹配的通知（按谓词过滤） */
  async waitForNotification(predicate: (m: ServerMessage) => boolean, timeoutMs = 10_000): Promise<ServerMessage> {
    const found = this.notifications.find(predicate);
    if (found !== undefined) {
      return found;
    }
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("等待通知超时")), timeoutMs);
      const check = (): void => {
        const message = this.notifications.find(predicate);
        if (message !== undefined) {
          clearTimeout(timer);
          this.notificationListeners = this.notificationListeners.filter((l) => l !== check);
          resolvePromise(message);
        }
      };
      this.notificationListeners.push(check);
    });
  }

  request(payload: Record<string, unknown>): Promise<ServerMessage> {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.write(`${JSON.stringify({ ...payload, id })}\n`);
    });
  }

  sendRaw(payload: Record<string, unknown>): void {
    this.socket.write(`${JSON.stringify(payload)}\n`);
  }

  close(): void {
    this.socket.destroy();
  }
}

describe("daemon 本地 API（named pipe / Unix socket）", () => {
  let handle: DaemonHandle;
  let home: string;
  let workspace: string;
  const token = "test-token";
  const model = "scripted/simple";
  let llmScript: { text?: string }[] = [{ text: "你好，会话已建立。" }];
  let lastLlm: import("@kcode/core").ScriptedLLM | undefined;
  const requestedModels: string[] = [];

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "kcode-daemon-home-"));
    workspace = await mkdtemp(join(tmpdir(), "kcode-daemon-ws-"));
    const pipePath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\kcode-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
        : join(home, "test.sock");
    handle = await startDaemon({
      pipePath,
      token,
      kcodeHomeDir: home,
      llmFactory: async (model: string) => {
        // 模拟生产路由：未配置的 provider 直接抛错
        if (!model.startsWith("scripted")) {
          throw new Error(`未配置 provider "${model.split("/")[0]}"`);
        }
        requestedModels.push(model);
        lastLlm = new ScriptedLLM(llmScript);
        return lastLlm;
      },
      modelsInfo: () => ({ default: "scripted/simple", providers: ["scripted"] }),
      daemonVersion: "test",
    });
  });

  afterAll(async () => {
    await handle.close();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  it("token 错误被拒绝；正确 token 完成 hello/ping", async () => {
    const bad = new ProtocolClient();
    await bad.open(handle.pipePath);
    await expect(bad.request({ method: "hello", token: "wrong", protocolVersion: 3 })).rejects.toThrow("token");
    bad.close();

    const client = new ProtocolClient();
    await client.open(handle.pipePath);
    const hello = await client.request({ method: "hello", token, protocolVersion: 3 });
    expect(hello.kind).toBe("hello_ok");
    const pong = await client.request({ method: "ping" });
    expect(pong.kind).toBe("pong");
    client.close();
  });

  it("建会话 → 发消息 → 收事件流与 run_done；JSONL 落盘", async () => {
    const client = new ProtocolClient();
    await client.open(handle.pipePath);
    await client.request({ method: "hello", token, protocolVersion: 3 });

    const created = await client.request({ method: "session_create", cwd: workspace, model });
    expect(created.kind).toBe("session_ok");
    const sessionId = (created as { sessionId: string }).sessionId;

    const accepted = await client.request({ method: "session_send", sessionId, content: "打个招呼" });
    expect(accepted.kind).toBe("accepted");
    const done = await client.waitForNotification((m) => m.kind === "run_done");
    expect(done.kind).toBe("run_done");
    const events = client.notifications.filter((m) => m.kind === "event");
    const types = events.map((e) => (e.kind === "event" ? e.event.type : ""));
    expect(types).toContain("session_start");
    expect(types).toContain("user_message");
    expect(types).toContain("assistant_message");
    expect(types).toContain("session_end");

    const { readFile } = await import("node:fs/promises");
    const jsonl = await readFile(join(home, "cli", "sessions", `${sessionId}.jsonl`), "utf8");
    expect(jsonl).toContain("打个招呼");
    client.close();
  });

  it("斜杠命令：列表与展开", async () => {
    await mkdir(join(workspace, ".kcode", "commands"), { recursive: true });
    await writeFile(join(workspace, ".kcode", "commands", "demo.md"), "演示命令：$ARGUMENTS", "utf8");
    const client = new ProtocolClient();
    await client.open(handle.pipePath);
    await client.request({ method: "hello", token, protocolVersion: 3 });
    const listed = await client.request({ method: "commands_list", cwd: workspace });
    expect(listed.kind).toBe("commands");
    expect((listed as { commands: { name: string }[] }).commands.some((c) => c.name === "demo")).toBe(true);
    const expanded = await client.request({ method: "command_expand", cwd: workspace, name: "demo", args: "参数" });
    expect(expanded.kind).toBe("command_expanded");
    expect((expanded as { template: string | null }).template).toBe("演示命令：参数");
    client.close();
  });

  it("resume：latest 续接上一会话历史", async () => {
    llmScript = [{ text: "第二轮回答。" }];
    const client = new ProtocolClient();
    await client.open(handle.pipePath);
    await client.request({ method: "hello", token, protocolVersion: 3 });
    const created = await client.request({ method: "session_create", cwd: workspace, model, resumeFrom: "latest" });
    expect(created.kind).toBe("session_ok");
    expect((created as { resumedMessages: number }).resumedMessages).toBeGreaterThan(0);
    client.close();
  });

  it("协议版本不一致被拒绝", async () => {
    const client = new ProtocolClient();
    await client.open(handle.pipePath);
    await expect(
      client.request({ method: "hello", token, protocolVersion: 99 }),
    ).rejects.toThrow("协议版本");
    client.close();
  });

  it("session_mode 四档切换 + ask 会话级放行 + diff 预览 + 权限决策落盘", async () => {
    llmScript = [
      // 第一轮（plan 档）：写入被拒
      { toolCalls: [{ callId: "c0", tool: "write", args: { path: "a.txt", content: "hello" } }] },
      { text: "计划模式下写入被拒绝" },
      // 第二轮（default 档）：写入触发 ask，scope=session 放行
      { toolCalls: [{ callId: "c1", tool: "write", args: { path: "a.txt", content: "hello" } }] },
      { text: "第一轮完成" },
      // 第三轮（会话级放行生效）：写入不再询问
      { toolCalls: [{ callId: "c2", tool: "write", args: { path: "b.txt", content: "world" } }] },
      { text: "第二轮完成" },
    ];
    const client = new ProtocolClient();
    await client.open(handle.pipePath);
    await client.request({ method: "hello", token, protocolVersion: 3 });
    const created = await client.request({
      method: "session_create",
      cwd: workspace,
      model,
    });
    const sessionId = (created as { sessionId: string }).sessionId;

    // 计数式等待本轮 run_done（同会话多轮的完成通知无法按 id 区分）
    const runDoneCount = (): number =>
      client.notifications.filter((m) => m.kind === "run_done").length;
    const waitNextRunDone = async (before: number): Promise<void> => {
      await client.waitForNotification(() => runDoneCount() > before);
    };

    // 切 plan 档：写工具应被直接拒绝（无 ask）
    await client.request({ method: "session_mode", sessionId, mode: "plan" });
    let before = runDoneCount();
    await client.request({ method: "session_send", sessionId, content: "计划模式尝试写入" });
    await waitNextRunDone(before);
    expect(client.notifications.some((m) => m.kind === "ask")).toBe(false);

    // 切回 default：写工具触发 ask，携 diff 预览；以 scope=session 放行
    await client.request({ method: "session_mode", sessionId, mode: "default" });
    before = runDoneCount();
    await client.request({ method: "session_send", sessionId, content: "写 a.txt" });
    const ask = await client.waitForNotification((m) => m.kind === "ask");
    expect(ask.kind).toBe("ask");
    expect(ask.tool).toBe("write");
    expect(ask.preview?.diff).toContain("+hello");
    client.sendRaw({
      id: 999,
      method: "ask_reply",
      callId: (ask as { callId: string }).callId,
      allowed: true,
      scope: "session",
    });
    await waitNextRunDone(before);

    // 第二轮写 b.txt：会话级放先生效，不再 ask
    before = runDoneCount();
    await client.request({ method: "session_send", sessionId, content: "写 b.txt" });
    await waitNextRunDone(before);
    const asks = client.notifications.filter((m) => m.kind === "ask");
    expect(asks).toHaveLength(1);

    const { existsSync } = await import("node:fs");
    const { readFile: readF } = await import("node:fs/promises");
    expect(existsSync(join(workspace, "a.txt"))).toBe(true);
    expect(existsSync(join(workspace, "b.txt"))).toBe(true);
    const jsonl = await readF(join(home, "cli", "sessions", `${sessionId}.jsonl`), "utf8");
    expect(jsonl).toContain("permission_decision");
    expect(jsonl).toContain("ask-allowed");
    expect(jsonl).toContain('"scope":"session"');
    client.close();
  });

  it("系统提示注入运行环境块（shell 方言/平台可见，模型不再猜）", async () => {
    llmScript = [{ text: "收到。" }];
    const client = new ProtocolClient();
    await client.open(handle.pipePath);
    await client.request({ method: "hello", token, protocolVersion: 3 });
    const created = await client.request({ method: "session_create", cwd: workspace, model });
    const sessionId = (created as { sessionId: string }).sessionId;
    await client.request({ method: "session_send", sessionId, content: "嗯" });
    await client.waitForNotification((m) => m.kind === "run_done");
    const system = lastLlm?.requests[0]?.messages[0];
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("<env>");
    expect(system?.content).toContain("OS=");
    expect(system?.content).toContain("shell=");
    client.close();
  });

  it("内置命令协议：models_list / session_set_model / skills_list / sessions_list", async () => {
    llmScript = [{ text: "ok" }, { text: "ok2" }];
    const client = new ProtocolClient();
    await client.open(handle.pipePath);
    await client.request({ method: "hello", token, protocolVersion: 3 });

    const models = await client.request({ method: "models_list" });
    expect(models.kind).toBe("models");
    expect((models as { providers: string[] }).providers).toContain("scripted");

    const created = await client.request({ method: "session_create", cwd: workspace, model });
    const sessionId = (created as { sessionId: string }).sessionId;
    await client.request({ method: "session_send", sessionId, content: "第一轮" });
    await client.waitForNotification((m) => m.kind === "run_done");

    // 运行期换模型：llmFactory 以新引用重建，后续请求的 model 字段随之变化
    const before = requestedModels.at(-1);
    const switched = await client.request({ method: "session_set_model", sessionId, model: "scripted/other" });
    expect(switched.kind).toBe("accepted");
    expect(requestedModels.at(-1)).toBe("scripted/other");
    expect(before).toBe(model);
    await client.request({ method: "session_send", sessionId, content: "第二轮" });
    const doneCount = client.notifications.filter((m) => m.kind === "run_done").length;
    await client.waitForNotification(() => client.notifications.filter((m) => m.kind === "run_done").length > doneCount);
    expect(lastLlm?.requests.at(-1)?.model).toBe("scripted/other");

    // 非法模型引用 → error 响应（客户端 request 对 error reject）
    await expect(
      client.request({ method: "session_set_model", sessionId, model: "nope/x" }),
    ).rejects.toThrow("未配置 provider");

    const skills = await client.request({ method: "skills_list", sessionId });
    expect(skills.kind).toBe("skills");

    const sessions = await client.request({ method: "sessions_list" });
    expect(sessions.kind).toBe("sessions");
    expect((sessions as { sessions: { sessionId: string }[] }).sessions.length).toBeGreaterThan(0);
    client.close();
  });

  it("hello 口令状态不一致 → 环境不匹配错误（客户端据此自动重拉）", async () => {
    const client = new ProtocolClient();
    await client.open(handle.pipePath);
    // 测试 daemon 环境无口令：客户端声明有口令 → 必须被拒
    await expect(
      client.request({ method: "hello", token, protocolVersion: 3, passphraseSet: true }),
    ).rejects.toThrow("环境不匹配");
    // 声明一致（无口令）→ 正常
    const okHello = await client.request({ method: "hello", token, protocolVersion: 3, passphraseSet: false });
    expect(okHello.kind).toBe("hello_ok");
    client.close();
  });
});

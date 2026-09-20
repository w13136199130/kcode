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
      llmFactory: async () => new ScriptedLLM(llmScript),
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
    await expect(bad.request({ method: "hello", token: "wrong", protocolVersion: 2 })).rejects.toThrow("token");
    bad.close();

    const client = new ProtocolClient();
    await client.open(handle.pipePath);
    const hello = await client.request({ method: "hello", token, protocolVersion: 2 });
    expect(hello.kind).toBe("hello_ok");
    const pong = await client.request({ method: "ping" });
    expect(pong.kind).toBe("pong");
    client.close();
  });

  it("建会话 → 发消息 → 收事件流与 run_done；JSONL 落盘", async () => {
    const client = new ProtocolClient();
    await client.open(handle.pipePath);
    await client.request({ method: "hello", token, protocolVersion: 2 });

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
    await client.request({ method: "hello", token, protocolVersion: 2 });
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
    await client.request({ method: "hello", token, protocolVersion: 2 });
    const created = await client.request({ method: "session_create", cwd: workspace, model, resumeFrom: "latest" });
    expect(created.kind).toBe("session_ok");
    expect((created as { resumedMessages: number }).resumedMessages).toBeGreaterThan(0);
    client.close();
  });
});

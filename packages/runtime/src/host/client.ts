import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { newId } from "@kcode/shared";
import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  HostFrame,
  type HostEvent,
  type SessionCreateResult,
  type SessionSubmitResult,
  type SessionsListResult,
} from "@kcode/contracts";

/**
 * 宿主客户端传输（N3-1 注 A：客户端只投递 + 收事件——排空权威在宿主）：
 * spawn 宿主进程 → stdio JSON-Line RPC；request 走 id 关联（宿主侧 commandId 幂等）。
 * 断连/进程退出 → 全部 pending reject（fail-fast）。
 */
export class HostClient {
  readonly #proc: ChildProcess;
  readonly #stdin: NodeJS.WritableStream;
  readonly #stdout: NodeJS.ReadableStream;
  readonly #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly #listeners = new Set<(event: HostEvent) => void>();
  #exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  #closed = false;

  private constructor(proc: ChildProcess, stdin: NodeJS.WritableStream, stdout: NodeJS.ReadableStream) {
    this.#proc = proc;
    this.#stdin = stdin;
    this.#stdout = stdout;
    this.#exited = new Promise((resolve) => {
      proc.on("exit", (code, signal) => resolve({ code, signal }));
    });
    proc.on("error", (err) => {
      this.#failAllPending(err instanceof Error ? err : new Error(String(err)));
    });
    const rl = createInterface({ input: stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const parsed = HostFrame.safeParse(JSON.parse(line));
      if (!parsed.success) return;
      this.#handleFrame(parsed.data);
    });
    stdin.on("error", () => this.#failAllPending(new Error("宿主 stdin 已关闭")));
  }

  /** 启动宿主进程并握手。exec 可覆盖启动命令（默认 node；源码 .ts 入口传 tsx 路径） */
  static async spawn(hostBin: string, opts: { cwd?: string; env?: Record<string, string>; exec?: string[] } = {}): Promise<HostClient> {
    const exec = opts.exec ?? [process.execPath];
    const cmd = exec[0]!;
    const args = [...exec.slice(1), hostBin];
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: "pipe",
      windowsHide: true,
    });
    const client = new HostClient(proc, proc.stdin, proc.stdout!);
    // 握手
    client.#stdin.write(`${JSON.stringify({ kind: "hello", hello: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR, capabilities: [] } })}\n`);
    await client.#waitForHello();
    return client;
  }

  async #waitForHello(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("宿主握手超时（5s）")), 5_000);
      const onEvent = (event: HostEvent): void => {
        if (event.type === "ready") {
          clearTimeout(timer);
          this.off(onEvent);
          resolve();
        }
      };
      this.on(onEvent);
    });
  }

  on(listener: (event: HostEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  off(listener: (event: HostEvent) => void): void {
    this.#listeners.delete(listener);
  }

  /** 等待某个事件类型到达（集成测试用） */
  waitFor(predicate: (event: HostEvent) => boolean, timeoutMs = 15_000): Promise<HostEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(listener);
        reject(new Error(`等待事件超时（${timeoutMs}ms）`));
      }, timeoutMs);
      const listener = (event: HostEvent): void => {
        if (predicate(event)) {
          clearTimeout(timer);
          this.off(listener);
          resolve(event);
        }
      };
      this.on(listener);
    });
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed) throw new Error("宿主客户端已关闭");
    const id = newId("req");
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const frame = JSON.stringify({ kind: "req", id, method, ...(params !== undefined ? { params } : {}) });
      this.#proc.stdin!.write(`${frame}\n`, (err) => {
        if (err !== undefined && err !== null) {
          this.#pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async createSession(params: { model: string; cwd: string; resumeFrom?: string }): Promise<SessionCreateResult> {
    return (await this.request("session/create", params)) as SessionCreateResult;
  }

  async submit(text: string, priority?: "now" | "next" | "later"): Promise<SessionSubmitResult> {
    return (await this.request("session/submit", { text, ...(priority !== undefined ? { priority } : {}) })) as SessionSubmitResult;
  }

  async interrupt(): Promise<{ cleared: number }> {
    return (await this.request("session/interrupt")) as { cleared: number };
  }

  async askRespond(requestId: string, allowed: boolean, scope?: "once" | "session" | "project"): Promise<void> {
    await this.request("ask/respond", { requestId, allowed, ...(scope !== undefined ? { scope } : {}) });
  }

  async questionRespond(requestId: string, labels: string[]): Promise<void> {
    await this.request("question/respond", { requestId, labels });
  }

  async setMode(mode: string): Promise<void> {
    await this.request("session/set_mode", { mode });
  }

  async sessionsList(): Promise<SessionsListResult> {
    return (await this.request("sessions/list")) as SessionsListResult;
  }

  /** 强杀宿主（kill -9 测试用） */
  kill(): void {
    this.#proc.kill("SIGKILL");
  }

  get exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.#exited;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAllPending(new Error("客户端主动关闭"));
    this.#proc.stdin?.end();
    this.#proc.kill();
  }

  #handleFrame(frame: HostFrame): void {
    if (frame.kind === "hello" || frame.kind === "ev") {
      if (frame.kind === "ev") {
        for (const listener of this.#listeners) {
          listener(frame.event);
        }
      }
      return;
    }
    const pending = this.#pending.get(frame.id);
    if (pending === undefined) return;
    this.#pending.delete(frame.id);
    if (frame.ok) {
      pending.resolve(frame.result);
    } else {
      pending.reject(new Error(frame.error));
    }
  }

  #failAllPending(err: Error): void {
    for (const [, pending] of this.#pending) {
      pending.reject(err);
    }
    this.#pending.clear();
  }
}

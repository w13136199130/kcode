import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_MAJOR, PROTOCOL_MINOR, type HostEvent, type HostFrame } from "@kcode/contracts";

/**
 * S3-3 多会话并行：后台会话管理器（宿主孵化宿主）。
 * 每个后台任务 = 一个无头 host 子进程（dist/main.cjs，stdio JSON-Line 原生协议），
 * KCODE_HOME 继承 → 会话 JSONL 落同一目录，侧栏经 fs.watch 自然可见；
 * 子进程事件原样转发（session/event 带 sessionId，renderer 由 S2-1 分片按 id 路由）。
 * lease 语义天然成立：后台 host 持租约（pid 存活）→ 前台切过去收到双活拒绝。
 */
export interface BackgroundSessionInfo {
  sessionId: string;
  busy: boolean;
  alive: boolean;
  preview: string;
  startedAt: number;
}

interface Entry {
  sessionId: string;
  child: ChildProcessWithoutNullStreams;
  busy: boolean;
  alive: boolean;
  preview: string;
  startedAt: number;
}

export interface BackgroundStartParams {
  model?: string;
  cwd?: string;
  prompt?: string;
}

/** 子进程启动配置（生产：ELECTRON_RUN_AS_NODE + dist/main.cjs；测试：注入 tsx 入口） */
export interface ChildSpawn {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function defaultSpawn(): ChildSpawn {
  // 打包态：本文件内联进 port.cjs，__dirname 即 dist/；main.cjs 为同构建的 stdio 入口
  const entry = join(__dirname, "main.cjs");
  if (!existsSync(entry)) {
    throw new Error(`后台会话入口未构建（${entry}）——先 pnpm --filter @kcode/host build`);
  }
  // KCODE_BG_EXEC：诊断/测试逃生口（如 "node"——排查 utility 进程 spawn electron 子进程的崩溃）
  const exec = process.env["KCODE_BG_EXEC"];
  if (exec !== undefined && exec !== "") {
    return { command: exec, args: [entry], env: { ...process.env } };
  }
  return {
    command: process.execPath,
    args: [entry],
    // electron 可执行体以纯 node 运行（desktop 的主 host 跑在 utilityProcess 里）
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  };
}

interface ChildFrame {
  kind?: string;
  id?: string;
  ok?: boolean;
  result?: { sessionId?: string };
  error?: string;
  event?: { type?: string; sessionId?: string };
}

export class BackgroundManager {
  readonly #entries = new Map<string, Entry>();
  #seq = 0;

  constructor(
    private readonly emit: (frame: HostFrame) => void,
    private readonly spawnConfig: ChildSpawn = defaultSpawn(),
  ) {}

  list(): BackgroundSessionInfo[] {
    return [...this.#entries.values()].map((entry) => ({
      sessionId: entry.sessionId,
      busy: entry.busy,
      alive: entry.alive,
      preview: entry.preview,
      startedAt: entry.startedAt,
    }));
  }

  async start(params: BackgroundStartParams): Promise<{ sessionId: string }> {
    const model = typeof params.model === "string" && params.model !== "" ? params.model : undefined;
    const cwd = typeof params.cwd === "string" && params.cwd !== "" ? params.cwd : undefined;
    const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
    if (model === undefined || cwd === undefined) throw new Error("后台任务需要 model 与 cwd");
    if (prompt === "") throw new Error("后台任务需要 prompt（首个指令）");

    const cfg = this.spawnConfig;
    const child = spawn(cfg.command, cfg.args, { env: cfg.env, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-800);
    });
    child.stdin.on("error", () => undefined); // 子进程已退（fail 路径负责报错）；EPIPE 不外抛
    const seq = ++this.#seq;
    const send = (frame: unknown): void => {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    };

    const entry: Entry = { sessionId: "", child, busy: true, alive: true, preview: prompt.slice(0, 80), startedAt: Date.now() };
    const sessionId = await new Promise<string>((resolve, reject) => {
      const fail = (reason: string): void => {
        clearTimeout(timer);
        child.kill();
        reject(new Error(reason));
      };
      const timer = setTimeout(() => fail("后台会话启动超时（20s）"), 20_000);
      child.on("exit", () => fail(`后台 host 提前退出${stderrTail !== "" ? `（stderr 尾部：${stderrTail.slice(-300)}` : ""}）`));
      child.on("error", (err) => fail(`后台 host 启动失败：${err.message}`));

      const rl = createInterface({ input: child.stdout });
      let handshaked = false;
      rl.on("line", (line) => {
        let frame: ChildFrame;
        try {
          frame = JSON.parse(line) as ChildFrame;
        } catch {
          return;
        }
        // 事件转发：只转本会话的 session/event（sessionId 在内层 SessionEvent，不在信封上）；
        // 结束事件（内层 session_end）更新 busy。
        if (frame.kind === "ev" && frame.event?.type === "session/event" && entry.sessionId !== "") {
          const inner = (frame.event as { event?: { type?: string; sessionId?: string } }).event;
          if (inner?.sessionId === entry.sessionId) {
            if (inner.type === "session_end") entry.busy = false;
            this.emit({ kind: "ev", event: frame.event as unknown as HostEvent });
          }
        }
        // 启动握手（仅一次；服务端 ready 已单次化，双保险防自激振荡）
        if (frame.kind === "ev" && frame.event?.type === "ready" && !handshaked) {
          handshaked = true;
          send({ kind: "hello", hello: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR, capabilities: ["session"] } });
          send({ kind: "req", id: `bg_create_${seq}`, method: "session/create", params: { model, cwd } });
          return;
        }
        if (frame.kind === "res" && frame.id === `bg_create_${seq}`) {
          if (frame.ok !== true || frame.result?.sessionId === undefined) {
            fail(`后台会话创建失败：${frame.error ?? "无会话 id"}`);
            return;
          }
          entry.sessionId = frame.result.sessionId;
          send({ kind: "req", id: `bg_submit_${seq}`, method: "session/submit", params: { text: prompt } });
          clearTimeout(timer);
          resolve(entry.sessionId);
          return;
        }
        if (frame.kind === "res" && frame.id === `bg_submit_${seq}` && frame.ok !== true) {
          // 提交失败可见（fail-closed：任务带错误落转写，busy 复位）
          this.emit({ kind: "ev", event: { type: "notice", message: `后台任务提交失败：${frame.error ?? "未知"}` } });
        }
      });
    });

    this.#entries.set(sessionId, entry);
    child.removeAllListeners("exit");
    child.on("exit", () => {
      entry.alive = false;
      entry.busy = false;
    });
    return { sessionId };
  }

  /** 停止：先优雅（stdin 关闭 → 子 host fail-closed 结算退出），3s 后强杀 */
  async stop(sessionId: string): Promise<{ stopped: boolean }> {
    const entry = this.#entries.get(sessionId);
    if (entry === undefined) return { stopped: false };
    const exited = new Promise<void>((resolve) => {
      entry.child.once("exit", () => resolve());
      setTimeout(resolve, 3_000);
    });
    entry.child.stdin.end();
    await exited;
    if (entry.alive) entry.child.kill();
    this.#entries.delete(sessionId);
    return { stopped: true };
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.#entries.keys()].map((id) => this.stop(id)));
  }
}

import { join } from "node:path";
import { newId } from "@kcode/shared";
import type {
  HostEvent,
  HostFrame,
  PermissionAnswer,
  PermissionAsker,
  PermissionMode,
  SessionCreateParams,
  SessionSubmitParams,
  SessionEvent,
  UserPromptPort,
} from "@kcode/contracts";
import { composeSession, resolveResumeHistory, type ComposedSession } from "@kcode/session";
import { RuntimeCommandQueue, loadSessionEvents, JsonlSessionSink } from "@kcode/runtime";
import { loadUserModelsConfig, createHostLlmFactory } from "./boot.js";

/**
 * 宿主侧会话（N3-1 注 A/B/C）：
 * - 排空权威在本进程：submit → 队列/预约/执行/取下一条，客户端只投递 + 收事件（注 A）；
 * - lease：接管时追加 host_lease {epoch=前值+1, pid}；前持有者 pid 仍存活 → 拒绝服务（注 B）；
 * - ask 往返：宿主发 ask/request → 等客户端应答或超时（10s）/断连 → 未决一律 deny（fail-closed，注 C）；
 * - 思考增量 250ms 合帧后下发（注 C：避免逐 delta 过线）。
 */
const ASK_TIMEOUT_MS = 10_000;
const REASONING_FLUSH_MS = 250;

export class HostSession {
  #composed: ComposedSession | null = null;
  #queue: RuntimeCommandQueue | null = null;
  #reservation = false;
  #pendingAsks = new Map<string, { resolve: (answer: PermissionAnswer) => void; timer: NodeJS.Timeout }>();
  #pendingQuestions = new Map<string, { resolve: (labels: string[]) => void; timer: NodeJS.Timeout }>();
  #reasoningBuffer = "";
  #reasoningTimer: NodeJS.Timeout | null = null;
  #epoch = 0;
  #closed = false;

  constructor(
    private readonly hostId: string,
    private readonly kcodeHomeDir: string,
    private readonly send: (frame: HostFrame) => void,
  ) {}

  async create(params: SessionCreateParams): Promise<{ sessionId: string; epoch: number }> {
    const models = await loadUserModelsConfig(this.kcodeHomeDir);
    const resume =
      params.resumeFrom !== undefined
        ? (await resolveResumeHistory(this.kcodeHomeDir, params.resumeFrom, params.cwd)) ?? undefined
        : undefined;
    if (params.resumeFrom !== undefined && resume === undefined) {
      throw new Error(`未找到会话「${params.resumeFrom}」`);
    }

    // lease 检查（注 B）：同会话前持有者仍存活 → 拒绝（防双活写回）；已死 → 接管（epoch+1）
    let prevEpoch = 0;
    if (params.resumeFrom !== undefined) {
      const target = await this.#findSessionFile(params.resumeFrom);
      if (target !== null) {
        const events = await loadSessionEvents(target);
        const leases = events.filter((e): e is Extract<SessionEvent, { type: "host_lease" }> => e.type === "host_lease");
        const last = leases.at(-1);
        if (last !== undefined) {
          prevEpoch = last.epoch;
          if (last.pid !== process.pid && this.#pidAlive(last.pid)) {
            throw new Error(
              `会话正被另一宿主持有（pid ${last.pid} 存活）——拒绝接管，防双活写回（注 B）`,
            );
          }
        }
      }
    }

    const composed = await composeSession({
      llmFactory: (model) => createHostLlmFactory(models, this.kcodeHomeDir)(model),
      model: params.model,
      cwd: params.cwd,
      kcodeHomeDir: this.kcodeHomeDir,
      resumeFrom: resume?.messages,
      resumeUsage: resume?.usage,
      // 事件/增量/通知全走 RPC
      onEvent: (event) => this.#emit({ type: "session/event", event }),
      onDelta: (text) => this.#emit({ type: "delta", text }),
      onReasoning: (delta) => this.#bufferReasoning(delta),
      onNotice: (message) => this.#emit({ type: "notice", message }),
      onQueueChange: (items) =>
        this.#emit({
          type: "queue/change",
          snapshot: { items: items.map((i) => ({ id: i.id, text: i.text, priority: i.priority })) },
        }),
      // ask 往返（fail-closed：断连/超时 deny）
      asker: this.#asker(),
      askUser: this.#askUser(),
    });
    this.#composed = composed;
    this.#queue = composed.commandQueue;
    this.#epoch = prevEpoch + 1;

    // 追加租约标记到 JSONL（append-only；sink 不关——composeSession 持有同一路径的 writer）
    const sink = await JsonlSessionSink.open(composed.jsonlPath);
    await sink.append({
      v: 1,
      type: "host_lease",
      ts: Date.now(),
      sessionId: composed.sessionId,
      hostId: this.hostId,
      pid: process.pid,
      epoch: this.#epoch,
    });

    this.#emit({ type: "session/created", sessionId: composed.sessionId, epoch: this.#epoch });
    return { sessionId: composed.sessionId, epoch: this.#epoch };
  }

  submit(params: SessionSubmitParams): { queued: boolean; position?: number } {
    if (this.#composed === null || this.#queue === null) throw new Error("会话未创建");
    if (this.#reservation) {
      this.#queue.enqueue(params.text, params.priority ?? "later");
      return { queued: true, position: this.#queue.size };
    }
    void this.#runOccupied(params.text);
    return { queued: false };
  }

  interrupt(): { cleared: number } {
    const cleared = this.#queue?.clear() ?? 0;
    this.#composed?.abort();
    // 中断即结算未决交互为 deny（不等待客户端）
    for (const [id, entry] of this.#pendingAsks) {
      clearTimeout(entry.timer);
      this.#pendingAsks.delete(id);
      entry.resolve({ allowed: false });
    }
    for (const [id, entry] of this.#pendingQuestions) {
      clearTimeout(entry.timer);
      this.#pendingQuestions.delete(id);
      entry.resolve([]);
    }
    return { cleared };
  }

  setMode(mode: PermissionMode): void {
    this.#composed?.setMode(mode);
  }

  async setModel(ref: string): Promise<{ error?: string } | undefined> {
    try {
      await this.#composed?.setModel(ref);
      return;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  askRespond(params: { requestId: string; allowed: boolean; scope?: "once" | "session" | "project" }): void {
    const entry = this.#pendingAsks.get(params.requestId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.#pendingAsks.delete(params.requestId);
    entry.resolve(
      !params.allowed
        ? { allowed: false }
        : params.scope === undefined
          ? { allowed: true }
          : { allowed: true, scope: params.scope },
    );
  }

  questionRespond(params: { requestId: string; labels: string[] }): void {
    const entry = this.#pendingQuestions.get(params.requestId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.#pendingQuestions.delete(params.requestId);
    entry.resolve(params.labels);
  }

  /** 断连/退出：fail-closed 结算全部未决交互 + 关会话 */
  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.interrupt();
    this.#flushReasoning();
    await this.#composed?.close();
  }

  // ---------- 内部 ----------

  /** 排空权威（注 A）：预约 → 执行 → 释放 → 取下一条（宿主侧递归，客户端不参与） */
  async #runOccupied(text: string): Promise<void> {
    if (this.#composed === null || this.#queue === null || this.#closed) return;
    if (!this.#queue.tryReserve()) {
      this.#queue.enqueue(text);
      return;
    }
    this.#reservation = true;
    try {
      const summary = await this.#composed.loop.run(text);
      this.#emit({ type: "session/summary", summary });
    } catch (err) {
      this.#emit({ type: "notice", message: `运行异常：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      this.#queue.release();
      this.#reservation = false;
      this.#flushReasoning();
      const next = this.#queue.dequeue();
      if (next !== undefined) {
        void this.#runOccupied(next.text);
      }
    }
  }

  #asker(): PermissionAsker {
    return {
      confirm: (call) =>
        new Promise<boolean | PermissionAnswer>((resolve) => {
          const requestId = newId("ask");
          const timer = setTimeout(() => {
            this.#pendingAsks.delete(requestId);
            resolve({ allowed: false }); // 超时 fail-closed
          }, ASK_TIMEOUT_MS);
          this.#pendingAsks.set(requestId, {
            resolve: (answer) => resolve(answer),
            timer,
          });
          this.#emit({
            type: "ask/request",
            requestId,
            tool: call.tool,
            args: call.args,
          });
        }),
    };
  }

  #askUser(): UserPromptPort {
    return {
      ask: (q) =>
        new Promise<string[]>((resolve) => {
          const requestId = newId("q");
          const timer = setTimeout(() => {
            this.#pendingQuestions.delete(requestId);
            resolve([]); // 超时空答
          }, ASK_TIMEOUT_MS * 3);
          this.#pendingQuestions.set(requestId, { resolve, timer });
          this.#emit({ type: "question/request", requestId, question: q });
        }),
    };
  }

  #bufferReasoning(delta: string): void {
    this.#reasoningBuffer += delta;
    if (this.#reasoningTimer === null) {
      this.#reasoningTimer = setTimeout(() => {
        this.#reasoningTimer = null;
        this.#flushReasoning();
      }, REASONING_FLUSH_MS);
    }
  }

  #flushReasoning(): void {
    if (this.#reasoningTimer !== null) {
      clearTimeout(this.#reasoningTimer);
      this.#reasoningTimer = null;
    }
    if (this.#reasoningBuffer !== "") {
      this.#emit({ type: "reasoning", text: this.#reasoningBuffer });
      this.#reasoningBuffer = "";
    }
  }

  #emit(event: HostEvent): void {
    this.send({ kind: "ev", event });
  }

  #pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async #findSessionFile(resumeFrom: string): Promise<string | null> {
    const sessionsDir = join(this.kcodeHomeDir, "cli", "sessions");
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(sessionsDir).catch(() => [] as string[]);
    const match = names.find((n) => n === `${resumeFrom}.jsonl` || n.replace(/\.jsonl$/, "").startsWith(resumeFrom));
    return match !== undefined ? join(sessionsDir, match) : null;
  }
}

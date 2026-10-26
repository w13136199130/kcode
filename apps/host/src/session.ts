import { join } from "node:path";
import { newId } from "@kcode/shared";
import type {
  HostEvent,
  HostFrame,
  PermissionAnswer,
  PermissionAsker,
  PermissionMode,
  PlanRespondParams,
  SessionCreateParams,
  SessionSubmitParams,
  SessionEvent,
  UserPromptPort,
} from "@kcode/contracts";
import { composeSession, resolveResumeHistory, type ComposedSession } from "@kcode/session";
import { RuntimeCommandQueue, effectiveEvents, loadSessionEvents, JsonlSessionSink } from "@kcode/runtime";
import { buildAskPreview, type AskPreview } from "@kcode/tools";
import { loadUserModelsConfig, createHostLlmFactory } from "./boot.js";
import { searchWorkspaceFiles } from "./files.js";

/**
 * 宿主侧会话（N3-1 注 A/B/C）：
 * - 排空权威在本进程：submit → 队列/预约/执行/取下一条，客户端只投递 + 收事件（注 A）；
 * - lease：接管时追加 host_lease {epoch=前值+1, pid}；前持有者 pid 仍存活 → 拒绝服务（注 B）；
 * - ask 往返：宿主发 ask/request → 等客户端应答或超时（10s）/断连 → 未决一律 deny（fail-closed，注 C）；
 * - 思考增量 250ms 合帧后下发（注 C：避免逐 delta 过线）。
 */
/** 桌面审批/计划面板要留给用户阅读完整命令/diff 的时间；断连仍立即 fail-closed */
const ASK_TIMEOUT_MS = 5 * 60_000;
const PLAN_TIMEOUT_MS = 5 * 60_000;
const REASONING_FLUSH_MS = 250;
/** kill -9 后 PID 可能短暂仍可被 signal 0 探测到；接管前给 OS 回收一个宽限窗口 */
const LEASE_TAKEOVER_GRACE_MS = 1_000;

export class HostSession {
  #composed: ComposedSession | null = null;
  #queue: RuntimeCommandQueue | null = null;
  #reservation = false;
  #pendingAsks = new Map<string, { resolve: (answer: PermissionAnswer) => void; timer: NodeJS.Timeout }>();
  #pendingQuestions = new Map<string, { resolve: (labels: string[]) => void; timer: NodeJS.Timeout }>();
  #pendingPlans = new Map<string, { resolve: (verdict: "approved" | "revise" | "abandon") => void; timer: NodeJS.Timeout }>();
  /** 当前会话 cwd：ask 预览（write 对比磁盘旧内容）需要 */
  #cwd = "";
  /** 中断代际：预览是异步的，预览期间被中断则不得再弹出过期审批 */
  #askEpoch = 0;
  #reasoningBuffer = "";
  #reasoningTimer: NodeJS.Timeout | null = null;
  /** D2-04：ask 与工具卡共用同一份 preview（write 会读磁盘，避免重复读） */
  #previewCache = new Map<string, Promise<AskPreview | undefined>>();
  #epoch = 0;
  #closed = false;

  constructor(
    private readonly hostId: string,
    private readonly kcodeHomeDir: string,
    private readonly send: (frame: HostFrame) => void,
  ) {}

  async create(
    params: SessionCreateParams,
    requestedSessionId?: string,
  ): Promise<{ sessionId: string; epoch: number }> {
    this.#cwd = params.cwd;
    const models = await loadUserModelsConfig(this.kcodeHomeDir);
    const resume =
      params.resumeFrom !== undefined
        ? (await resolveResumeHistory(this.kcodeHomeDir, params.resumeFrom, params.cwd)) ?? undefined
        : undefined;
    if (params.resumeFrom !== undefined && resume === undefined) {
      throw new Error(`未找到会话「${params.resumeFrom}」`);
    }

    // lease 检查（注 B）：同会话前持有者仍存活 → 拒绝（防双活写回）；已死 → 接管（epoch+1）。
    // 续接源 id 直接来自 resolveResumeHistory——不再用 resumeFrom 反查文件；
    // 否则 "latest"/前缀查不到文件，latest 会被当成新会话（丢连续性）。
    let prevEpoch = 0;
    const resumeSessionId = resume?.sessionId;
    const targetSessionId = resumeSessionId ?? requestedSessionId;
    if (resumeSessionId !== undefined) {
      const target = join(this.kcodeHomeDir, "cli", "sessions", `${resumeSessionId}.jsonl`);
      const events = await loadSessionEvents(target);
      const leases = events.filter((e): e is Extract<SessionEvent, { type: "host_lease" }> => e.type === "host_lease");
      const last = leases.at(-1);
      if (last !== undefined) {
        prevEpoch = last.epoch;
        if (last.pid !== process.pid && this.#pidAlive(last.pid)) {
          // kill -9 / 断电恢复：进程退出与 PID 回收不是同一瞬间。给一个短宽限，
          // 避免把"刚被杀的旧宿主"误判为双活；宽限后仍存活才拒绝。
          await new Promise((resolve) => setTimeout(resolve, LEASE_TAKEOVER_GRACE_MS));
          if (this.#pidAlive(last.pid)) {
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
      sessionId: targetSessionId,
      resumeUsage: resume?.usage,
      // 事件/增量/通知全走 RPC
      onEvent: (event) => {
        this.#emit({ type: "session/event", event });
        if (event.type === "tool_call") {
          this.#emitPreview({ callId: event.callId, tool: event.tool, args: event.args ?? {} });
        }
        if (event.type === "tool_result") this.#previewCache.delete(event.callId);
      },
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
      // 计划批准：桌面端 plan_submit 必须有交互通道，否则计划模式不可用
      planAsker: this.#planAsker(),
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

  /** 既有会话描述（session/create 幂等命中时返回——与 create 同形） */
  describe(): { sessionId: string; epoch: number } {
    if (this.#composed === null) throw new Error("会话未创建");
    return { sessionId: this.#composed.sessionId, epoch: this.#epoch };
  }

  /**
   * 转写重放（M2b）：当前会话 JSONL 的事件清单（reload 后 renderer 重建转写用）。
   * 返回原始事件（含 user/assistant/tool/compact 等），renderer 侧投影。
   */
  async replay(): Promise<{ sessionId: string; events: SessionEvent[] }> {
    if (this.#composed === null) throw new Error("会话未创建");
    // loadSessionEvents 收的是文件路径，不是会话 id；且必须过 effectiveEvents，
    // 否则 /rewind 掉的内容会在 reload 后复活。
    const events = effectiveEvents(await loadSessionEvents(this.#composed.jsonlPath));
    return { sessionId: this.#composed.sessionId, events };
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
    this.#askEpoch += 1;
    this.#composed?.abort();
    // 中断即结算未决交互为 deny（不等待客户端）
    for (const [id, entry] of this.#pendingAsks) {
      clearTimeout(entry.timer);
      this.#pendingAsks.delete(id);
      this.#emit({ type: "ask/cancelled", requestId: id });
      entry.resolve({ allowed: false });
    }
    for (const [id, entry] of this.#pendingQuestions) {
      clearTimeout(entry.timer);
      this.#pendingQuestions.delete(id);
      entry.resolve([]);
    }
    for (const [id, entry] of this.#pendingPlans) {
      clearTimeout(entry.timer);
      this.#pendingPlans.delete(id);
      this.#emit({ type: "plan/cancelled", requestId: id });
      entry.resolve("abandon");
    }
    return { cleared };
  }

  setMode(mode: PermissionMode): void {
    this.#composed?.setMode(mode);
  }

  async listChanges(): Promise<Array<{ path: string; diff: string; callIds: string[]; existed: boolean }>> {
    if (this.#composed === null) throw new Error("会话未创建");
    return this.#composed.listChanges();
  }

  listTasks(): ReturnType<NonNullable<ComposedSession["backgroundTasks"]>> {
    if (this.#composed === null) throw new Error("会话未创建");
    return this.#composed.backgroundTasks();
  }

  listCommands(): Array<{ name: string; source: "project" | "user" }> {
    if (this.#composed === null) return [];
    return this.#composed.listCommands();
  }

  expandCommand(name: string, args: string): Promise<string | null> {
    if (this.#composed === null) throw new Error("会话未创建");
    return this.#composed.expandCommand(name, args);
  }

  compact(): Promise<{ dropped: number; summaryChars: number } | null> {
    if (this.#composed === null) throw new Error("会话未创建");
    return this.#composed.compactNow();
  }

  async searchFiles(query: string): Promise<string[]> {
    if (this.#cwd === "") return [];
    return searchWorkspaceFiles(this.#cwd, query);
  }

  stopTask(id: string): { stopped: boolean } {
    if (this.#composed === null) throw new Error("会话未创建");
    return { stopped: this.#composed.stopBackgroundTask(id) };
  }

  async revertChanges(paths?: string[]): Promise<{ restoredFiles: number }> {
    if (this.#composed === null) throw new Error("会话未创建");
    if (this.#reservation) throw new Error("运行中不能回退文件");
    return this.#composed.revertChanges(paths);
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

  planRespond(params: PlanRespondParams): void {
    const entry = this.#pendingPlans.get(params.requestId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.#pendingPlans.delete(params.requestId);
    entry.resolve(params.verdict);
  }

  /** 释放当前会话（同窗口切会话用——进程继续活、后续可 create 新会话；与 shutdown 终态区分） */
  async dispose(): Promise<void> {
    await this.shutdown();
    this.#closed = false; // 恢复可创建态
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

  #preview(call: { callId: string; tool: string; args: unknown }): Promise<AskPreview | undefined> {
    const cached = this.#previewCache.get(call.callId);
    if (cached !== undefined) return cached;
    const pending = buildAskPreview(call.tool, call.args, {
      sessionId: call.callId,
      cwd: this.#cwd,
    }).catch(() => undefined);
    this.#previewCache.set(call.callId, pending);
    return pending;
  }

  /** D2-04：工具卡的 diff 与审批同源；即使 acceptEdits 不弹 ask 也发一次 */
  #emitPreview(call: { callId: string; tool: string; args: unknown }): void {
    if (call.tool !== "write" && call.tool !== "edit") return;
    void this.#preview(call).then((preview) => {
      if (preview !== undefined) {
        this.#emit({ type: "tool/preview", callId: call.callId, preview });
      }
    });
  }

  #asker(): PermissionAsker {
    return {
      confirm: async (call) => {
        // 预览在宿主侧生成：renderer 无文件访问；write 需要对比磁盘旧内容
        const epoch = this.#askEpoch;
        const preview = await this.#preview(call);
        // 预览期间被中断/关会话：不再弹一个已经过期的审批
        if (epoch !== this.#askEpoch) return { allowed: false };
        return new Promise<boolean | PermissionAnswer>((resolve) => {
          const requestId = newId("ask");
          const timer = setTimeout(() => {
            this.#pendingAsks.delete(requestId);
            this.#emit({ type: "ask/cancelled", requestId });
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
            ...(preview !== undefined ? { preview } : {}),
          });
        });
      },
    };
  }

  /** 计划批准端口：plan_submit → plan/request → 客户端 plan/respond */
  #planAsker(): { ask(plan: string): Promise<"approved" | "revise" | "abandon"> } {
    return {
      ask: (plan) =>
        new Promise((resolve) => {
          const requestId = newId("plan");
          const timer = setTimeout(() => {
            this.#pendingPlans.delete(requestId);
            this.#emit({ type: "plan/cancelled", requestId });
            resolve("abandon");
          }, PLAN_TIMEOUT_MS);
          this.#pendingPlans.set(requestId, { resolve, timer });
          this.#emit({ type: "plan/request", requestId, plan });
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

}

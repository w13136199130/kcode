import {
  type ChatMessage,
  type RunStatus,
  type HookPreOutcome,
  type HookRunner,
  type LLMProvider,
  type PermissionAsker,
  type PermissionEngine,
  type SessionEvent,
  type SessionSink,
  type SkillPort,
  type SummarizerPort,
  type Tool,
  type ToolOutput,
  type ToolRegistry,
} from "@kcode/contracts";
import { estimateTokens, newId } from "@kcode/shared";
import { assembleMessages } from "../context/assemble.js";
import { capToolResult, contextWindowFor, deriveBudget, historyTokens, type Budget } from "../context/budget.js";
import {
  applyCompaction,
  planCompaction,
  type CompactionResult,
} from "../context/compact.js";
import { ToolPipeline, type AuditSink } from "./pipeline.js";

export interface AgentLoopPorts {
  llm: LLMProvider;
  tools: ToolRegistry;
  permissions: PermissionEngine;
  hooks: HookRunner;
  sink: SessionSink;
  audit: AuditSink;
  /** ask 交互确认（§5.1）：CLI 注入；缺省时 ask 按 deny 降级 */
  asker?: PermissionAsker;
  /** 流式文本增量（瞬态）：TUI 实时渲染用；JSONL 只在完成时落 assistant_message */
  onDelta?: (delta: string) => void;
  /** 思考过程增量（瞬态，reasoning 模型）：TUI 灰色实时渲染；不回传 API，落盘见 assistant_message.reasoning */
  onReasoning?: (delta: string) => void;
  /** 技能库（渐进加载/自动触发；core 零 IO，extensions 实现） */
  skills?: SkillPort;
  /** 历史摘要器：上下文超预算时生成结构化摘要；缺省时退化为占位压缩 */
  summarizer?: SummarizerPort;
}

export interface AgentLoopOptions {
  sessionId?: string;
  model: string;
  systemPrompt: string;
  /** 会话工作目录：注入 ToolContext，工具的相对路径以此为基准 */
  cwd?: string;
  /** 工作区身份键：落盘到 session_start，供会话分组/续接作用域使用 */
  workspaceKey?: string;
  /** AGENTS.md 项目记忆（会话期不变，进稳定区，§5.3） */
  agentsMd?: string;
  /** 续接历史（resume/分支：由会话 JSONL 重建，§5.3） */
  initialHistory?: ChatMessage[];
  /** 续接的历史累计用量（旧会话全部 session_end.usage 求和；/cost 跨续接可见） */
  initialUsage?: SessionUsage;
  maxTurns?: number;
  now?: () => number;
  budget?: Budget;
}

/** 会话累计用量（/cost 数据源；initialUsage 种子 + 本进程各轮增量） */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  /** LLM 调用次数（含端点未回报用量的调用） */
  calls: number;
}

export interface RunSummary {
  status: RunStatus;
  sessionId: string;
  turns: number;
  toolCalls: number;
}

interface PendingCall {
  callId: string;
  tool: string;
  args: unknown;
}

/**
 * Loop 状态机（§5.1）：用户输入 → 上下文组装 → LLM(流式) → 工具调用(并行) → 结果回填 → 循环/结束。
 * 每步产生 JSONL 事件；core 零 IO——llm/tools/sink/audit 全部注入。
 */
export class AgentLoop {
  readonly sessionId: string;
  private readonly pipeline: ToolPipeline;
  private history: ChatMessage[] = [];
  private systemPrompt: string;
  private started = false;
  private model: string;
  private llm: LLMProvider;
  private summarizer?: SummarizerPort;
  private usage: SessionUsage;
  /** B3：预算随模型窗口派生（opts.budget 显式指定时以指定为准） */
  private budget: Budget;
  private contextWindow: number;
  /** B3：跨压缩保真锚点（已批准的执行计划） */
  private pinnedAnchor?: ChatMessage;

  constructor(
    private readonly ports: AgentLoopPorts,
    private readonly opts: AgentLoopOptions,
  ) {
    this.sessionId = opts.sessionId ?? newId("sess");
    this.systemPrompt = opts.systemPrompt;
    this.history = [...(opts.initialHistory ?? [])];
    this.model = opts.model;
    this.llm = ports.llm;
    this.summarizer = ports.summarizer;
    this.usage = opts.initialUsage ?? { inputTokens: 0, outputTokens: 0, calls: 0 };
    this.contextWindow = contextWindowFor(opts.model);
    this.budget = opts.budget ?? deriveBudget(this.contextWindow);
    this.pipeline = new ToolPipeline(
      ports.permissions,
      ports.hooks,
      this.auditWithPermissionEvents(ports.audit),
      this.sessionId,
      opts.cwd,
      ports.asker,
    );
  }

  /** 会话累计用量（含 resume 种子）；/cost 经本地会话读取 */
  getUsage(): SessionUsage {
    return { ...this.usage };
  }

  /**
   * 审计记录中的交互/拒绝项翻译为 permission_decision 事件落盘：
   * 只记 ask 应答与规则拒绝——规则放行是高频常态，落盘只添噪声。
   */
  private auditWithPermissionEvents(base: AuditSink): AuditSink {
    return (record) => {
      base(record);
      if (
        record.decision !== "ask-allowed" &&
        record.decision !== "ask-denied" &&
        record.decision !== "deny"
      ) {
        return;
      }
      void Promise.resolve(
        this.emit({
          v: 1,
          type: "permission_decision",
          ts: record.ts,
          sessionId: record.sessionId,
          callId: record.callId,
          tool: record.tool,
          decision: record.decision,
          ...(record.scope !== undefined ? { scope: record.scope } : {}),
          ...(record.detail !== undefined ? { detail: record.detail } : {}),
        }),
      ).catch(() => {
        // 审计事件落盘失败不阻断工具管线
      });
    };
  }

  /** 运行期更换 system prompt（计划模式切换等，§1.1 A 域） */
  updateSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /** 整体替换历史（/rewind 回退：由会话 JSONL 事件重建后注入；须在空闲时调用） */
  replaceHistory(messages: ChatMessage[]): void {
    this.history = [...messages];
  }

  /** 运行期更换模型（/model）：LLM 实例与摘要器一并重建，历史保留；预算随新模型窗口重算 */
  updateModel(model: string, llm: LLMProvider, summarizer?: SummarizerPort): void {
    this.model = model;
    this.llm = llm;
    if (summarizer !== undefined) {
      this.summarizer = summarizer;
    }
    if (this.opts.budget === undefined) {
      this.contextWindow = contextWindowFor(model);
      this.budget = deriveBudget(this.contextWindow);
    }
  }

  /** 锚点钉固（B3）：跨压缩保真的上下文（已批准的执行计划） */
  pinAnchor(text: string): void {
    this.pinnedAnchor = { role: "user", content: text };
  }

  /** 手动压缩（/compact）：跳过预算判定，仍受最短历史守卫；空闲时调用 */
  async compactNow(): Promise<CompactionResult | null> {
    return this.maybeCompact(true);
  }

  /** 上下文占用（/context 可视化数据源） */
  contextStats(): { model: string; contextWindow: number; historyTokens: number; historyBudget: number; systemTokens: number; pinnedAnchor: boolean } {
    return {
      model: this.model,
      contextWindow: this.contextWindow,
      historyTokens: historyTokens(this.history),
      historyBudget: this.budget.history,
      systemTokens: estimateTokens(this.systemPrompt),
      pinnedAnchor: this.pinnedAnchor !== undefined,
    };
  }

  private get now(): () => number {
    return this.opts.now ?? Date.now;
  }

  /**
   * 上下文压缩：历史超预算时，把较早消息交给摘要器生成结构化摘要，
   * 以「任务锚点 + 摘要 + 近期原文」替换原历史；未配置摘要器时退化为计数占位。
   */
  private async maybeCompact(force = false): Promise<CompactionResult | null> {
    const plan = planCompaction(this.history, this.budget, force);
    if (plan === null) {
      return null;
    }
    // pre_compact 钩子（B5）：退出码 2 = 跳过本次压缩
    const gate = await this.gateHook((h) =>
      h.onPreCompact?.({ sessionId: this.sessionId, dropped: plan.toSummarize.length }),
    );
    if (gate.veto) {
      return null;
    }
    let summary: string;
    if (this.summarizer !== undefined) {
      summary = await this.summarizer.summarize({ messages: plan.toSummarize });
    } else {
      summary = `【历史压缩】已折叠 ${plan.toSummarize.length} 条较早消息（未配置摘要器，仅保留任务与近期上下文）`;
    }
    const applied = applyCompaction(plan, summary, this.pinnedAnchor !== undefined ? [this.pinnedAnchor] : []);
    this.history = applied.history;
    return { summary, dropped: applied.dropped, covered: plan.toSummarize.length };
  }

  private async emit(event: SessionEvent): Promise<void> {
    await this.ports.sink.append(event);
  }

  async run(
    userInput: string,
    runOpts: { images?: string[]; signal?: AbortSignal; runId?: string } = {},
  ): Promise<RunSummary> {
    const ts = this.now;
    if (!this.started) {
      this.started = true;
      await this.emit({
        v: 1,
        type: "session_start",
        ts: ts(),
        sessionId: this.sessionId,
        model: this.model,
        ...(this.opts.workspaceKey !== undefined ? { workspaceKey: this.opts.workspaceKey } : {}),
      });
      await this.fireLifecycleHook((h) => h.onSessionStart?.({ sessionId: this.sessionId }));
    }
    // 否决必须先于用户消息和技能注入，避免下一轮重新发送被拒绝内容。
    const promptGate = await this.gateHook((h) =>
      h.onUserPromptSubmit?.({ sessionId: this.sessionId, prompt: userInput }),
    );
    if (promptGate.veto || runOpts.signal?.aborted) {
      const status = runOpts.signal?.aborted ? "aborted" : "rejected";
      await this.emit({ v: 1, type: "session_end", ts: ts(), sessionId: this.sessionId,
        reason: status, ...(promptGate.reason !== undefined ? { detail: promptGate.reason } : {}) });
      await this.fireLifecycleHook((h) => h.onStop?.({ sessionId: this.sessionId }));
      return { sessionId: this.sessionId, turns: 0, toolCalls: 0, status };
    }
    await this.emit({
      v: 1,
      type: "user_message",
      ts: ts(),
      sessionId: this.sessionId,
      content: userInput,
    });
    // 技能自动触发（§5.2）：命中关键词 → 渐进加载正文注入动态区（本轮用户输入之前）
    const triggered = this.ports.skills?.match(userInput) ?? [];
    for (const skill of triggered) {
      const body = await this.ports.skills!.body(skill.name);
      this.history.push({
        role: "user",
        content: `<skill name="${skill.name}">\n${body}\n</skill>`,
      });
      await this.emit({
        v: 1,
        type: "skill_used",
        ts: ts(),
        sessionId: this.sessionId,
        skill: skill.name,
        trigger: "auto",
      });
    }
    this.history.push({
      role: "user",
      content: userInput,
      ...(runOpts.images !== undefined && runOpts.images.length > 0
        ? { images: runOpts.images }
        : {}),
    });

    const maxTurns = this.opts.maxTurns ?? 20;
    let turns = 0;
    let toolCalls = 0;
    let status: RunStatus = "limit_reached";
    // 本轮 run 的用量增量：session_end 落盘，resume 侧对全部 session_end 求和
    const runUsage: SessionUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };
    const signal = runOpts.signal;
    try {
      while (turns < maxTurns) {
        if (signal?.aborted) {
          break;
        }
        turns++;
        // 压缩在组装之前执行：超预算先生成摘要替换旧历史，再拼装本轮请求
        const compacted = await this.maybeCompact();
        if (compacted !== null) {
          await this.emit({
            v: 1,
            type: "compaction_summary",
            ts: ts(),
            sessionId: this.sessionId,
            summary: compacted.summary,
            dropped: compacted.dropped,
            covered: compacted.covered,
          });
        }

        const tools = this.ports.tools.list();
        const messages = assembleMessages({
          systemPrompt: this.systemPrompt,
          agentsMd: this.opts.agentsMd,
          tools: tools.map((t) => t.definition),
          skills: this.ports.skills?.meta(),
          history: this.history,
        });

        let text = "";
        let reasoning = "";
        let streamError: string | undefined;
        const calls: PendingCall[] = [];
        try {
          runUsage.calls++;
          for await (const chunk of this.llm.stream({
            model: this.model,
            messages,
            tools: tools.map((t) => ({
              name: t.definition.name,
              description: t.definition.description,
              parameters: t.definition.parameters,
            })),
            signal,
          })) {
            if (chunk.type === "reasoning") {
              reasoning += chunk.text;
              this.ports.onReasoning?.(chunk.text);
            } else if (chunk.type === "text") {
              text += chunk.text;
              this.ports.onDelta?.(chunk.text);
            } else if (chunk.type === "tool_call") {
              calls.push({ callId: chunk.callId, tool: chunk.tool, args: chunk.args });
              await this.emit({
                v: 1,
                type: "tool_call",
                ts: ts(),
                sessionId: this.sessionId,
                callId: chunk.callId,
                tool: chunk.tool,
                args: chunk.args,
              });
            } else if (chunk.type === "end") {
              if (chunk.reason === "error") {
                // LLM 调用失败必须可见（鉴权错/模型不存在/网络断）——静默吞掉等于界面假死
                streamError = chunk.error ?? "未知错误";
              }
              if (chunk.usage !== undefined) {
                runUsage.inputTokens += chunk.usage.inputTokens;
                runUsage.outputTokens += chunk.usage.outputTokens;
              }
            }
          }
        } catch (err) {
          if (signal?.aborted) {
            // 用户中断：流被掐断是预期行为，不作为错误
          } else {
            throw err;
          }
        }
        if (signal?.aborted) {
          if (text !== "" || reasoning !== "") {
            await this.emit({
              v: 1,
              type: "assistant_message",
              ts: ts(),
              sessionId: this.sessionId,
              content: text,
              ...(reasoning !== "" ? { reasoning } : {}),
            });
            if (text !== "") {
              this.history.push({ role: "assistant", content: text });
            }
          }
          break;
        }
        if (streamError !== undefined) {
          status = "failed";
          if (text !== "" || reasoning !== "") {
            await this.emit({
              v: 1,
              type: "assistant_message",
              ts: ts(),
              sessionId: this.sessionId,
              content: text,
              ...(reasoning !== "" ? { reasoning } : {}),
            });
            if (calls.length === 0 && text !== "") {
              this.history.push({ role: "assistant", content: text });
            }
          }
          await this.emit({
            v: 1,
            type: "llm_error",
            ts: ts(),
            sessionId: this.sessionId,
            error: streamError,
          });
          break;
        }
        if (text !== "" || reasoning !== "") {
          await this.emit({
            v: 1,
            type: "assistant_message",
            ts: ts(),
            sessionId: this.sessionId,
            content: text,
            ...(reasoning !== "" ? { reasoning } : {}),
          });
        }
        if (calls.length === 0) {
          status = "completed";
          if (text !== "") {
            this.history.push({ role: "assistant", content: text });
          }
          break;
        }
        toolCalls += calls.length;
        // 记录含 toolCalls 的 assistant 轮次：OpenAI 兼容端点要求 tool 结果前有对应 tool_calls
        this.history.push({ role: "assistant", content: text, toolCalls: calls });

        // §5.1：一轮多个只读工具并发执行；任一非只读则串行
        const results = await this.executeCalls(calls, tools, signal);
        for (let i = 0; i < calls.length; i++) {
          const call = calls[i]!;
          const { result, durationMs } = results[i]!;
          await this.emit({
            v: 1,
            type: "tool_result",
            ts: ts(),
            sessionId: this.sessionId,
            callId: call.callId,
            ok: result.ok,
            output: result.output,
            ...(result.error !== undefined ? { error: result.error } : {}),
            durationMs,
          });
          this.history.push({
            role: "tool",
            // B3 micro：发给模型的副本超预算截断（头尾保留）；JSONL 事件仍为全文
            content: capToolResult(result.output !== "" ? result.output : (result.error ?? ""), this.budget),
            toolCallId: call.callId,
            name: call.tool,
          });
          // extract 图片挂载：以带图 user 消息注入（ChatMessage.images 既有通道），
          // 视觉模型可直接查看；文本模型忽略。成本护栏：最多 3 张。
          if (result.imagePaths !== undefined && result.imagePaths.length > 0) {
            this.history.push({
              role: "user",
              content: `<tool_image tool="extract">${result.imagePaths.join("\n")}</tool_image>（工具挂载的图片，供视觉查看）`,
              images: result.imagePaths.slice(0, 3),
            });
          }
        }
      }
    } catch (err) {
      status = "failed";
      throw err;
    } finally {
      if (signal?.aborted) status = "aborted";
      if (status === "limit_reached") {
        // 防失控上限到顶：明确告知（历史保留，用户可输入「继续」接着做）
        await this.emit({
          v: 1,
          type: "run_limit_reached",
          ts: ts(),
          sessionId: this.sessionId,
          maxTurns,
        });
      }
      await this.emit({
        v: 1,
        type: "session_end",
        ts: ts(),
        sessionId: this.sessionId,
        reason: status,
        usage: { ...runUsage },
      });
      this.usage.inputTokens += runUsage.inputTokens;
      this.usage.outputTokens += runUsage.outputTokens;
      this.usage.calls += runUsage.calls;
      await this.fireLifecycleHook((h) => h.onStop?.({ sessionId: this.sessionId }));
    }
    return { sessionId: this.sessionId, turns, toolCalls, status };
  }

  /** 会话级钩子：失败只记录不抛出——钩子故障不应中断会话主流程 */
  private async fireLifecycleHook(invoke: (hooks: HookRunner) => Promise<void> | void): Promise<void> {
    try {
      await invoke(this.ports.hooks);
    } catch {
      // 生命周期钩子异常静默降级；工具级钩子的错误处理在管线内完成
    }
  }

  /** 门型钩子（可否决）：未实现/异常按放行（fail-open 的兜底在 runner 内处理） */
  private async gateHook(
    invoke: (hooks: HookRunner) => Promise<HookPreOutcome> | undefined,
  ): Promise<HookPreOutcome> {
    try {
      return (await invoke(this.ports.hooks)) ?? { veto: false };
    } catch {
      return { veto: false };
    }
  }

  private async executeCalls(
    calls: PendingCall[],
    tools: Tool[],
    signal?: AbortSignal,
  ): Promise<Array<{ result: ToolOutput; durationMs: number }>> {
    const byName = new Map(tools.map((t) => [t.definition.name, t] as const));
    const allReadOnly = calls.every((c) => byName.get(c.tool)?.definition.readOnly === true);
    if (allReadOnly) {
      return Promise.all(calls.map((c) => this.executeOne(byName, c, signal)));
    }
    const results: Array<{ result: ToolOutput; durationMs: number }> = [];
    for (const call of calls) {
      if (signal?.aborted) {
        // 用户中断：未开始的调用直接按取消结算（已在执行中的由其自身超时收敛）
        results.push({
          result: { ok: false, output: "", error: "aborted（用户中断）" },
          durationMs: 0,
        });
        continue;
      }
      results.push(await this.executeOne(byName, call, signal));
    }
    return results;
  }

  private async executeOne(
    byName: Map<string, Tool>,
    call: PendingCall,
    signal?: AbortSignal,
  ): Promise<{ result: ToolOutput; durationMs: number }> {
    const tool = byName.get(call.tool);
    if (tool === undefined) {
      return {
        result: { ok: false, output: "", error: `unknown tool: ${call.tool}` },
        durationMs: 0,
      };
    }
    const startedAt = this.now();
    const result = await this.pipeline.run(tool, call.args, call.callId, signal);
    return { result, durationMs: Math.max(0, this.now() - startedAt) };
  }
}

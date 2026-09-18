import {
  type ChatMessage,
  type HookRunner,
  type LLMProvider,
  type PermissionEngine,
  type SessionEvent,
  type SessionSink,
  type Tool,
  type ToolOutput,
  type ToolRegistry,
} from "@kcode/contracts";
import { newId } from "@kcode/shared";
import { assembleMessages } from "../context/assemble.js";
import { DEFAULT_BUDGET, type Budget } from "../context/budget.js";
import { compactHistory } from "../context/compact.js";
import { ToolPipeline, type AuditSink } from "./pipeline.js";

export interface AgentLoopPorts {
  llm: LLMProvider;
  tools: ToolRegistry;
  permissions: PermissionEngine;
  hooks: HookRunner;
  sink: SessionSink;
  audit: AuditSink;
}

export interface AgentLoopOptions {
  sessionId?: string;
  model: string;
  systemPrompt: string;
  /** 会话工作目录：注入 ToolContext，工具的相对路径以此为基准 */
  cwd?: string;
  maxTurns?: number;
  now?: () => number;
  budget?: Budget;
}

export interface RunSummary {
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
  private started = false;

  constructor(
    private readonly ports: AgentLoopPorts,
    private readonly opts: AgentLoopOptions,
  ) {
    this.sessionId = opts.sessionId ?? newId("sess");
    this.pipeline = new ToolPipeline(
      ports.permissions,
      ports.hooks,
      ports.audit,
      this.sessionId,
      opts.cwd,
    );
  }

  private get now(): () => number {
    return this.opts.now ?? Date.now;
  }

  private async emit(event: SessionEvent): Promise<void> {
    await this.ports.sink.append(event);
  }

  async run(userInput: string): Promise<RunSummary> {
    const ts = this.now;
    if (!this.started) {
      this.started = true;
      await this.emit({
        v: 1,
        type: "session_start",
        ts: ts(),
        sessionId: this.sessionId,
        model: this.opts.model,
      });
    }
    await this.emit({
      v: 1,
      type: "user_message",
      ts: ts(),
      sessionId: this.sessionId,
      content: userInput,
    });
    this.history.push({ role: "user", content: userInput });

    const maxTurns = this.opts.maxTurns ?? 20;
    let turns = 0;
    let toolCalls = 0;
    try {
      while (turns < maxTurns) {
        turns++;
        // 压缩时机由 context 决定（§5.2）：超预算先压缩再组装，摘要事件写回 JSONL（回放可见）
        const compaction = compactHistory(this.history, this.opts.budget ?? DEFAULT_BUDGET);
        if (compaction) {
          this.history = compaction.history;
          await this.emit({
            v: 1,
            type: "compaction_summary",
            ts: ts(),
            sessionId: this.sessionId,
            summary: compaction.summary,
            dropped: compaction.dropped,
          });
        }

        const tools = this.ports.tools.list();
        const messages = assembleMessages({
          systemPrompt: this.opts.systemPrompt,
          tools: tools.map((t) => t.definition),
          history: this.history,
        });

        let text = "";
        const calls: PendingCall[] = [];
        for await (const chunk of this.ports.llm.stream({
          model: this.opts.model,
          messages,
          tools: tools.map((t) => ({
            name: t.definition.name,
            description: t.definition.description,
            parameters: t.definition.parameters,
          })),
        })) {
          if (chunk.type === "text") {
            text += chunk.text;
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
          }
        }
        if (text !== "") {
          await this.emit({
            v: 1,
            type: "assistant_message",
            ts: ts(),
            sessionId: this.sessionId,
            content: text,
          });
          this.history.push({ role: "assistant", content: text });
        }
        if (calls.length === 0) break;
        toolCalls += calls.length;

        // §5.1：一轮多个只读工具并发执行；任一非只读则串行
        const results = await this.executeCalls(calls, tools);
        for (let i = 0; i < calls.length; i++) {
          const call = calls[i]!;
          const result = results[i]!;
          await this.emit({
            v: 1,
            type: "tool_result",
            ts: ts(),
            sessionId: this.sessionId,
            callId: call.callId,
            ok: result.ok,
            output: result.output,
            ...(result.error !== undefined ? { error: result.error } : {}),
          });
          this.history.push({
            role: "tool",
            content: result.output !== "" ? result.output : (result.error ?? ""),
            toolCallId: call.callId,
            name: call.tool,
          });
        }
      }
    } finally {
      await this.emit({
        v: 1,
        type: "session_end",
        ts: ts(),
        sessionId: this.sessionId,
        reason: turns >= maxTurns ? "aborted" : "completed",
      });
    }
    return { sessionId: this.sessionId, turns, toolCalls };
  }

  private async executeCalls(calls: PendingCall[], tools: Tool[]): Promise<ToolOutput[]> {
    const byName = new Map(tools.map((t) => [t.definition.name, t] as const));
    const allReadOnly = calls.every((c) => byName.get(c.tool)?.definition.readOnly === true);
    if (allReadOnly) {
      return Promise.all(calls.map((c) => this.executeOne(byName, c)));
    }
    const results: ToolOutput[] = [];
    for (const call of calls) {
      results.push(await this.executeOne(byName, call));
    }
    return results;
  }

  private async executeOne(byName: Map<string, Tool>, call: PendingCall): Promise<ToolOutput> {
    const tool = byName.get(call.tool);
    if (tool === undefined) {
      return { ok: false, output: "", error: `unknown tool: ${call.tool}` };
    }
    return this.pipeline.run(tool, call.args, call.callId);
  }
}

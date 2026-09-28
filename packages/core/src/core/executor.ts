import type { Tool, ToolOutput } from "@kcode/contracts";
import type { ToolPipeline } from "./pipeline.js";

/** 待执行工具调用（LLM 一轮产出） */
export interface PendingCall {
  callId: string;
  tool: string;
  args: unknown;
}

export interface CallOutcome {
  result: ToolOutput;
  durationMs: number;
}

/**
 * 轮次执行器（自 loop.ts 外迁，N2-5 拆分）：
 * 一轮多个只读工具并发执行；任一非只读则串行（§5.1）；
 * 用户中断时未开始的调用按取消结算（已在执行中的由其自身超时收敛）。
 */
export class TurnExecutor {
  constructor(
    private readonly pipeline: ToolPipeline,
    private readonly now: () => number,
  ) {}

  async executeCalls(calls: PendingCall[], tools: Tool[], signal?: AbortSignal): Promise<CallOutcome[]> {
    const byName = new Map(tools.map((t) => [t.definition.name, t] as const));
    const allReadOnly = calls.every((c) => byName.get(c.tool)?.definition.readOnly === true);
    if (allReadOnly) {
      return Promise.all(calls.map((c) => this.executeOne(byName, c, signal)));
    }
    const results: CallOutcome[] = [];
    for (const call of calls) {
      if (signal?.aborted) {
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
  ): Promise<CallOutcome> {
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

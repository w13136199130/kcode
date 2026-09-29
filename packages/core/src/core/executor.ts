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

/** 单组并发上限（对标 zcode scheduler.ts:48；防一次 fan-out 打爆本机） */
const MAX_GROUP_CONCURRENCY = 10;

/**
 * 轮次执行器（自 loop.ts 外迁，N2-5 拆分；N3D-1 升级为并行组模型）：
 * 一批调用按"可并行性"分组——并行工具（readOnly 或显式 concurrentSafe）成组并发，
 * 非并行工具独占单例组、组间顺序执行。此前"任一非只读则整批串行"会把同批的读调用
 * 一起拖慢，也堵死了多个 task（子代理）的 fan-out（对标 zcode scheduler.ts:154 分组；
 * 其"失败跳过后续组"策略已废弃，不重蹈——单工具失败不截断后续组）。
 * 用户中断时未开始的调用按取消结算（已在执行中的由其自身超时收敛）。
 */
export class TurnExecutor {
  constructor(
    private readonly pipeline: ToolPipeline,
    private readonly now: () => number,
  ) {}

  async executeCalls(calls: PendingCall[], tools: Tool[], signal?: AbortSignal): Promise<CallOutcome[]> {
    const byName = new Map(tools.map((t) => [t.definition.name, t] as const));
    const canRunParallel = (name: string): boolean => {
      const def = byName.get(name)?.definition;
      if (def === undefined) return false;
      return def.concurrentSafe ?? def.readOnly === true;
    };

    // 分组：连续的并行调用聚成一组，非并行调用各自单例组（保持原相对顺序）
    const groups: PendingCall[][] = [];
    for (const call of calls) {
      const parallel = canRunParallel(call.tool);
      const last = groups.at(-1);
      if (parallel && last !== undefined && last[0] !== undefined && canRunParallel(last[0]!.tool)) {
        last.push(call);
      } else {
        groups.push([call]);
      }
    }

    // 按原调用顺序回填结果
    const outcomes = new Map<string, CallOutcome>();
    for (const group of groups) {
      if (signal?.aborted) {
        for (const call of group) {
          outcomes.set(call.callId, {
            result: { ok: false, output: "", error: "aborted（用户中断）" },
            durationMs: 0,
          });
        }
        continue;
      }
      // 组内并发按上限分片（同 zcode：Promise.all 一片）
      for (let i = 0; i < group.length; i += MAX_GROUP_CONCURRENCY) {
        const chunk = group.slice(i, i + MAX_GROUP_CONCURRENCY);
        const settled = await Promise.all(chunk.map((c) => this.executeOne(byName, c, signal)));
        chunk.forEach((c, j) => outcomes.set(c.callId, settled[j]!));
      }
    }
    return calls.map((c) =>
      outcomes.get(c.callId) ?? { result: { ok: false, output: "", error: "未执行（调度遗漏）" }, durationMs: 0 },
    );
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

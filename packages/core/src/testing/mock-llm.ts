import type { LLMChunk, LLMProvider, LLMRequest } from "@kcode/contracts";

export interface ScriptedToolCall {
  callId: string;
  tool: string;
  args: unknown;
}

export interface ScriptedTurn {
  /** 单块文本（整体一块输出） */
  text?: string;
  /** 多块文本（模拟流式增量） */
  textParts?: string[];
  /** 思考过程块（reasoning 模型模拟；先于正文输出） */
  reasoningParts?: string[];
  /** 模拟 LLM 调用失败（end chunk reason=error） */
  error?: string;
  toolCalls?: ScriptedToolCall[];
  /** 模拟端点回报的 token 用量（end chunk 携带；缺省不报——旧回放夹具保持字节一致） */
  usage?: { inputTokens: number; outputTokens: number };
}

/** mock LLM（§11.A ②）：按脚本吐 chunk；记录收到的请求供测试/evals 断言 */
export class ScriptedLLM implements LLMProvider {
  readonly id = "mock";
  readonly requests: LLMRequest[] = [];

  #script: ScriptedTurn[];

  constructor(script: ScriptedTurn[]) {
    this.#script = [...script];
  }

  async *stream(req: LLMRequest): AsyncIterable<LLMChunk> {
    this.requests.push(req);
    const turn = this.#script.shift();
    if (turn === undefined) {
      yield { type: "end", reason: "stop" };
      return;
    }
    for (const part of turn.reasoningParts ?? []) {
      yield { type: "reasoning", text: part };
    }
    if (turn.textParts !== undefined) {
      for (const part of turn.textParts) {
        yield { type: "text", text: part };
      }
    } else if (turn.text !== undefined) {
      yield { type: "text", text: turn.text };
    }
    if (turn.error !== undefined) {
      yield { type: "end", reason: "error", error: turn.error, ...(turn.usage !== undefined ? { usage: turn.usage } : {}) };
      return;
    }
    for (const call of turn.toolCalls ?? []) {
      yield { type: "tool_call", callId: call.callId, tool: call.tool, args: call.args };
    }
    yield {
      type: "end",
      reason: (turn.toolCalls?.length ?? 0) > 0 ? "tool_use" : "stop",
      ...(turn.usage !== undefined ? { usage: turn.usage } : {}),
    };
  }
}

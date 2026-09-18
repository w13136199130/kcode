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
  toolCalls?: ScriptedToolCall[];
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
    if (turn.textParts !== undefined) {
      for (const part of turn.textParts) {
        yield { type: "text", text: part };
      }
    } else if (turn.text !== undefined) {
      yield { type: "text", text: turn.text };
    }
    for (const call of turn.toolCalls ?? []) {
      yield { type: "tool_call", callId: call.callId, tool: call.tool, args: call.args };
    }
    yield { type: "end", reason: (turn.toolCalls?.length ?? 0) > 0 ? "tool_use" : "stop" };
  }
}

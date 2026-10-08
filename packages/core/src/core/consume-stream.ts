import type { ChatMessage, LLMProvider, SessionEvent, Tool } from "@kcode/contracts";
import type { PendingCall } from "./executor.js";
/** 用量累加器形状（结构化内联——避免与 loop.ts 循环依赖；规范类型见 loop.SessionUsage） */
interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

/**
 * 流式消费（自 loop.ts 抽出为独立模块，N3D-2 行数治理）：
 * 消费 LLM 流——text/reasoning 增量回调、tool_call 事件落盘、end 用量累计/错误捕获。
 * 中断语义：signal 已中止时吞掉流异常（用户中断是预期行为，不是错误）。
 */
export async function consumeStream(dep: {
  llm: LLMProvider;
  model: string;
  sessionId: string;
  onDelta?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  emit: (event: SessionEvent) => Promise<void>;
  messages: ChatMessage[];
  tools: Tool[];
  signal?: AbortSignal;
  runUsage: UsageAccumulator;
  ts: () => number;
}): Promise<{ text: string; reasoning: string; streamError?: string; calls: PendingCall[]; lastInputTokens?: number }> {
  let text = "";
  let reasoning = "";
  let streamError: string | undefined;
  const calls: PendingCall[] = [];
  let lastInputTokens: number | undefined;
  try {
    dep.runUsage.calls++;
    for await (const chunk of dep.llm.stream({
      model: dep.model,
      messages: dep.messages,
      tools: dep.tools.map((t) => ({
        name: t.definition.name,
        description: t.definition.description,
        parameters: t.definition.parameters,
      })),
      signal: dep.signal,
    })) {
      if (chunk.type === "reasoning") {
        reasoning += chunk.text;
        dep.onReasoning?.(chunk.text);
      } else if (chunk.type === "text") {
        text += chunk.text;
        dep.onDelta?.(chunk.text);
      } else if (chunk.type === "tool_call") {
        calls.push({ callId: chunk.callId, tool: chunk.tool, args: chunk.args });
        await dep.emit({
          v: 1,
          type: "tool_call",
          ts: dep.ts(),
          sessionId: dep.sessionId,
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
          dep.runUsage.inputTokens += chunk.usage.inputTokens;
          dep.runUsage.outputTokens += chunk.usage.outputTokens;
          // provider 回报的本轮输入侧总量 = 该请求的上下文真值（system+工具 schema+历史全量），
          // loop 以最近一次值校准压缩判据（N3 对齐批：估算降为兜底）
          lastInputTokens = chunk.usage.inputTokens;
        }
      }
    }
  } catch (err) {
    if (dep.signal?.aborted) {
      // 用户中断：流被掐断是预期行为，不作为错误
    } else {
      throw err;
    }
  }
  return { text, reasoning, streamError, calls, lastInputTokens };
}


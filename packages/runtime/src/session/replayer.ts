import { SessionEvent } from "@kcode/contracts";
import type { ChatMessage, ToolCallPart } from "@kcode/contracts";

/**
 * 回放（§8.2，replay 安全）：回放 harness 全局 replay 模式——hooks 不执行、
 * 工具执行器替换为录制结果；本模块只读不执行，CI 中真实命令/hooks 永不运行。
 */

/**
 * 逐行解析 JSONL 事件流。
 * stopOnError=true：遇到坏行（多为崩溃时追加到一半的尾部截断）立即停止并返回已解析的有效前缀，用于崩溃恢复；
 * stopOnError=false：坏行抛错，用于夹具校验（坏夹具应在 CI 里响亮失败）。
 */
function parseJsonl(text: string, stopOnError: boolean): SessionEvent[] {
  const events: SessionEvent[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      if (stopOnError) return events;
      throw new Error(`fixture 第 ${i + 1} 行不是合法 JSON: ${String(err)}`);
    }
    const parsed = SessionEvent.safeParse(raw);
    if (!parsed.success) {
      if (stopOnError) return events;
      throw new Error(`fixture 第 ${i + 1} 行不符合 v:1 事件契约: ${parsed.error.message}`);
    }
    events.push(parsed.data);
  }
  return events;
}

/** 严格解析（夹具校验）：坏行抛错 */
export function parseJsonlSession(text: string): SessionEvent[] {
  return parseJsonl(text, false);
}

/** 宽松解析（崩溃恢复）：坏行视为尾部截断，返回已解析的有效前缀 */
export function parseJsonlPrefix(text: string): SessionEvent[] {
  return parseJsonl(text, true);
}

/** 比较录制与产出的事件序列（忽略 ts），返回首个差异——eval 断言锚点 */
export function compareIgnoringTs(
  recorded: SessionEvent[],
  produced: SessionEvent[],
): { equal: boolean; firstDiff?: string } {
  if (recorded.length !== produced.length) {
    return {
      equal: false,
      firstDiff: `长度不一致: recorded=${recorded.length} produced=${produced.length}`,
    };
  }
  for (let i = 0; i < recorded.length; i++) {
    const a = stripTs(recorded[i]!);
    const b = stripTs(produced[i]!);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      return {
        equal: false,
        firstDiff: `第 ${i + 1} 个事件不一致:\n  recorded: ${JSON.stringify(a)}\n  produced: ${JSON.stringify(b)}`,
      };
    }
  }
  return { equal: true };
}

function stripTs(event: SessionEvent): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(event as Record<string, unknown>) };
  delete copy["ts"];
  return copy;
}

/**
 * 有效事件前缀（M1-02 /rewind）：取**最后一条** session_rewind 的 keepEvents 作为截断点。
 *
 * 回退是 append-only 的标记而非物理改写，因此有效历史 = 标记之前的 keepEvents 个事件。
 * 之所以只存下标即可：JSONL 只追加，早于标记的事件永不改变，
 * `events.slice(0, keepEvents)` 恒等于回退当时的有效历史。
 *
 * 所有"事件流 → 会话状态"的消费者都必须先过这里，否则重启后会复活已回退内容。
 */
export function effectiveEvents(events: SessionEvent[]): SessionEvent[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "session_rewind") {
      return events.slice(0, event.keepEvents);
    }
  }
  return events;
}

/**
 * 事件流 → 会话历史（§5.3 resume/分支）：
 * - 先按 session_rewind 截断到有效前缀，被回退的内容不复活；
 * - tool_call 批次与紧随的 assistant_message 文本合并为带 toolCalls 的 assistant 轮次；
 * - compaction_summary 还原为摘要占位消息（与在线压缩后的历史形态一致）；
 * - session_start/end、todo_update、session_rewind 跳过（元数据/UI 态）；
 * - skill_used 不含正文，续接时不重注入（渐进加载只在当轮生效）。
 */
export function rebuildHistory(allEvents: SessionEvent[]): ChatMessage[] {
  const events = effectiveEvents(allEvents);
  const history: ChatMessage[] = [];
  const callTools = new Map<string, string>();
  let pendingCalls: ToolCallPart[] = [];
  let pendingText: string | null = null;

  const flushAssistantTurn = (): void => {
    if (pendingCalls.length > 0) {
      history.push({ role: "assistant", content: pendingText ?? "", toolCalls: pendingCalls });
      pendingCalls = [];
      pendingText = null;
    }
  };

  for (const event of events) {
    switch (event.type) {
      case "user_message":
        flushAssistantTurn();
        history.push({ role: "user", content: event.content });
        break;
      case "assistant_message":
        if (pendingCalls.length > 0) {
          pendingText = event.content;
        } else {
          flushAssistantTurn();
          history.push({ role: "assistant", content: event.content });
        }
        break;
      case "tool_call":
        callTools.set(event.callId, event.tool);
        pendingCalls.push({ callId: event.callId, tool: event.tool, args: event.args });
        break;
      case "tool_result":
        flushAssistantTurn();
        history.push({
          role: "tool",
          content: event.output !== "" ? event.output : (event.error ?? ""),
          toolCallId: event.callId,
          name: callTools.get(event.callId) ?? "",
        });
        break;
      case "compaction_summary":
        flushAssistantTurn();
        // 折叠头部 covered 条，保留首用户锚点，再放摘要与尾部：
        // 这样回放出的历史与在线压缩后的历史一致，既不复活已折叠内容，也不与原文重复。
        {
          const covered = event.covered ?? event.dropped;
          const folded = history.splice(0, Math.max(0, covered));
          const anchor = folded.find((m) => m.role === "user");
          history.unshift({ role: "assistant", content: event.summary });
          if (anchor !== undefined) {
            history.unshift(anchor);
          }
        }
        break;
      default:
        break;
    }
  }
  // 收尾：崩溃于 tool_result 落盘之前会留下无结果的 tool_call——
  // 结果未知的写操作不得在续接时被模型当作待执行而重放，丢弃这些调用，仅保留已产出的正文。
  if (pendingCalls.length > 0 && pendingText !== null && pendingText !== "") {
    history.push({ role: "assistant", content: pendingText });
  }
  return history;
}

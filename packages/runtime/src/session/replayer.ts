import { SessionEvent } from "@kcode/contracts";

/**
 * 回放（§8.2，replay 安全）：回放 harness 全局 replay 模式——hooks 不执行、
 * 工具执行器替换为录制结果；本模块只读不执行，CI 中真实命令/hooks 永不运行。
 */

/** 解析 JSONL 夹具为事件序列；非法行带行号报错 */
export function parseJsonlSession(text: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new Error(`fixture 第 ${i + 1} 行不是合法 JSON: ${String(err)}`);
    }
    const parsed = SessionEvent.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`fixture 第 ${i + 1} 行不符合 v:1 事件契约: ${parsed.error.message}`);
    }
    events.push(parsed.data);
  }
  return events;
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

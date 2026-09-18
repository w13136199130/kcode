/** 纯工具函数（§4.1：零外部依赖） */

/** 生成带前缀的 ID：sess_xxx / agent_xxx / call_xxx */
export function newId(prefix: string): string {
  const c = globalThis.crypto;
  const uuid =
    c?.randomUUID !== undefined ? c.randomUUID() : Math.random().toString(36).slice(2, 12);
  return `${prefix}_${uuid}`;
}

/** JSONL 行序列化（append-only 事件流，ADR-7） */
export function jsonlLine(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

/** 粗估 token 数：P0 用长度/3，P1 换真实 tokenizer（providers 能力探测） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

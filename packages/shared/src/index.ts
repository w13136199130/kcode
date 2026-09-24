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

/** 工作区身份键：同一目录不同写法（分隔符/尾斜杠）归一为同一身份；本地退化为规范化路径 */
export function workspaceKey(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === "" ? "/" : normalized;
}

/**
 * token 估算（B3）：CJK 感知的分段系数——中文约 0.75 token/字（GLM/DeepSeek 分词实测区间），
 * 西文约 3.8 字符/token；比长度/3 的失真（中文高估 ~3 倍）显著更接近真实计量。
 * 真实 tokenizer（按模型族编码表）在 providers 能力探测落地后替换。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! > 0x2e80) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk * 0.75 + other / 3.8);
}

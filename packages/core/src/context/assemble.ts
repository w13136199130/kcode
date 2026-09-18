import type { ChatMessage, ToolDefinition } from "@kcode/contracts";

export interface AssembleInput {
  systemPrompt: string;
  tools: ToolDefinition[];
  history: ChatMessage[];
}

/**
 * cache 友好组装（§5.2）：
 * [稳定区] system prompt → 工具描述（按名称排序，字节级稳定）→ 历史；
 * [动态区] 本轮新工具结果随后进入 history 参与下一轮。
 * 前缀逐字节稳定以命中 prompt cache（省 50–90% 输入成本）。
 */
export function assembleMessages(input: AssembleInput): ChatMessage[] {
  const toolLines = [...input.tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => `- ${t.name}: ${t.description}`);
  const system =
    toolLines.length === 0
      ? input.systemPrompt
      : `${input.systemPrompt}\n\nTools:\n${toolLines.join("\n")}`;
  return [{ role: "system", content: system }, ...input.history];
}

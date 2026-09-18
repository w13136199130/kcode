import type { ChatMessage, SkillMeta, ToolDefinition } from "@kcode/contracts";

export interface AssembleInput {
  systemPrompt: string;
  /** 项目/用户级 AGENTS.md（会话期不变 → 稳定区，§5.3 记忆） */
  agentsMd?: string;
  tools: ToolDefinition[];
  /** 技能元数据（渐进加载第一级：仅名称+描述进稳定区，§5.2） */
  skills?: SkillMeta[];
  history: ChatMessage[];
}

/**
 * cache 友好组装（§5.2）：
 * [稳定区] system prompt → AGENTS.md → 工具描述（按名称排序）→ 技能元数据（按名称排序）→ 历史；
 * [动态区] 本轮触发的技能正文与用户输入随后进入 history。
 * 前缀逐字节稳定以命中 prompt cache（省 50–90% 输入成本）。
 */
export function assembleMessages(input: AssembleInput): ChatMessage[] {
  const sections: string[] = [input.systemPrompt];

  if (input.agentsMd !== undefined && input.agentsMd.trim() !== "") {
    sections.push(`# 项目记忆（AGENTS.md）\n${input.agentsMd.trim()}`);
  }

  const toolLines = [...input.tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => `- ${t.name}: ${t.description}`);
  if (toolLines.length > 0) {
    sections.push(`Tools:\n${toolLines.join("\n")}`);
  }

  const skillLines = [...(input.skills ?? [])]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((s) => `- ${s.name}: ${s.description}`);
  if (skillLines.length > 0) {
    sections.push(
      `Skills（命中关键词自动加载，或要求使用时加载）:\n${skillLines.join("\n")}`,
    );
  }

  const system = sections.filter((s) => s.trim() !== "").join("\n\n");
  return [{ role: "system", content: system }, ...input.history];
}

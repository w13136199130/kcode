/** 子 agent（§5.1）：独立上下文用完即弃，仅结论回流主会话；后台运行与消息互通 P5 落地 */

export type SubagentType = "general-purpose" | "explore" | "judge";

export interface SubagentSpec {
  type: SubagentType;
  prompt: string;
}

export interface SubagentResult {
  summary: string;
}

export interface SubagentRunner {
  run(spec: SubagentSpec): Promise<SubagentResult>;
}

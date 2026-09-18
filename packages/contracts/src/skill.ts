import { z } from "zod";

/** SKILL.md 清单（frontmatter）：技能 = 目录 + SKILL.md（§1.1 C 域） */
export const SkillManifest = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-_.]{1,63}$/),
  description: z.string().min(1).max(500),
  /** 自动触发关键词（空 = 仅手动调用；第三方技能默认手动，§5.4） */
  triggers: z.array(z.string()).default([]),
});
export type SkillManifest = z.infer<typeof SkillManifest>;

/** 注入稳定区的技能元数据（渐进加载第一级，§5.2） */
export interface SkillMeta {
  name: string;
  description: string;
}

/**
 * 技能端口（core 零 IO）：发现/渐进加载/触发匹配由 extensions 实现，组合层注入。
 * meta() 只进 system prompt 稳定区；body() 命中后才读取（渐进披露）。
 */
export interface SkillPort {
  meta(): SkillMeta[];
  body(name: string): Promise<string>;
  match(input: string): SkillMeta[];
}

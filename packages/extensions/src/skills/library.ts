import { readFile } from "node:fs/promises";
import type { SkillManifest, SkillMeta, SkillPort } from "@kcode/contracts";
import { discoverSkills, type DiscoveredSkill, type SkillSource } from "./discover.js";
import { parseSkillMd } from "./parse.js";

/** 自动触发最多注入的技能数（防上下文爆炸） */
const MAX_TRIGGERED = 3;

/** 3-18：技能来源策略 + frontmatter 的 disable-model-invocation */
export interface SkillEntry {
  name: string;
  description: string;
  source: SkillSource["source"];
  allowedTools?: string[];
  /** 仅手动（/skill）：项目/插件技能默认如此，或 frontmatter 显式禁用模型调用 */
  manualOnly: boolean;
}

/**
 * 第三方技能默认手动（§5.4 / 3-18）：
 * - project（克隆仓库）与 plugin（安装的第三方插件）**永不**自动注入/模型加载；
 * - user/builtin 可通过 `disable-model-invocation: true` 显式设为手动。
 * 显式 `false` 不能把项目/插件技能提升为自动——来源策略优先，避免静默注入。
 */
export function isManualOnly(source: SkillSource["source"], manifest: SkillManifest): boolean {
  if (source === "project" || source === "plugin") {
    return true;
  }
  return manifest.disableModelInvocation === true;
}

/**
 * 文件系统技能库（§5.2 渐进加载）：
 * meta() 常驻 system prompt 稳定区（仅名称+描述）；match() 命中后 body() 才读正文。
 * 3-18：meta()/match()/body() 对模型隐藏手动技能；用户 /skill 走 manualBody()。
 */
export class FsSkillLibrary implements SkillPort {
  readonly #discovered: DiscoveredSkill[];
  readonly #bodies = new Map<string, string>();

  private constructor(discovered: DiscoveredSkill[]) {
    this.#discovered = discovered;
  }

  static async open(roots: SkillSource[], onWarn?: (message: string) => void): Promise<FsSkillLibrary> {
    return new FsSkillLibrary(await discoverSkills(roots, onWarn));
  }

  /** 全部技能（CLI /skills 盘点用，含手动技能与来源） */
  list(): SkillEntry[] {
    return this.#discovered.map((s) => ({
      name: s.manifest.name,
      description: s.manifest.description,
      source: s.source,
      ...(s.manifest.allowedTools !== undefined ? { allowedTools: s.manifest.allowedTools } : {}),
      manualOnly: isManualOnly(s.source, s.manifest),
    }));
  }

  /** 模型可见的技能元数据：手动技能不出现（避免模型尝试调用后再被拒） */
  meta(): SkillMeta[] {
    return this.#discovered
      .filter((s) => !isManualOnly(s.source, s.manifest))
      .map((s) => ({ name: s.manifest.name, description: s.manifest.description }));
  }

  /** 模型通道加载正文：手动技能抛错（skill 工具会转成可读错误） */
  async body(name: string): Promise<string> {
    const found = this.#require(name);
    if (isManualOnly(found.source, found.manifest)) {
      throw new Error(
        `技能「${name}」为手动技能（${found.source === "project" || found.source === "plugin" ? `${found.source} 来源默认手动` : "disable-model-invocation"}），模型不能主动加载；请用户使用 /skill ${name}`,
      );
    }
    return this.#readBody(found);
  }

  /** 用户 /skill 通道：绕过模型调用策略（仍要求技能存在） */
  async manualBody(name: string): Promise<string> {
    return this.#readBody(this.#require(name));
  }

  /** 触发匹配：输入包含任一 trigger（大小写不敏感）；手动技能与无 triggers 不自动触发 */
  match(input: string): SkillMeta[] {
    const lower = input.toLowerCase();
    const matched = this.#discovered.filter(
      (s) =>
        !isManualOnly(s.source, s.manifest) &&
        s.manifest.triggers.some((trigger) => trigger.trim() !== "" && lower.includes(trigger.toLowerCase())),
    );
    return matched
      .sort((a, b) => (a.manifest.name < b.manifest.name ? -1 : 1))
      .slice(0, MAX_TRIGGERED)
      .map((s) => ({ name: s.manifest.name, description: s.manifest.description }));
  }

  #require(name: string): DiscoveredSkill {
    const found = this.#discovered.find((s) => s.manifest.name === name);
    if (found === undefined) {
      throw new Error(`技能不存在: ${name}`);
    }
    return found;
  }

  async #readBody(found: DiscoveredSkill): Promise<string> {
    const cached = this.#bodies.get(found.manifest.name);
    if (cached !== undefined) {
      return cached;
    }
    const parsed = parseSkillMd(await readFile(found.filePath, "utf8"));
    if (!parsed.ok) {
      throw new Error(`技能正文解析失败: ${parsed.error}`);
    }
    this.#bodies.set(found.manifest.name, parsed.skill.body);
    return parsed.skill.body;
  }
}

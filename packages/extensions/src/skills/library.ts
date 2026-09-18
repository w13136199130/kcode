import { readFile } from "node:fs/promises";
import type { SkillMeta, SkillPort } from "@kcode/contracts";
import { discoverSkills, type DiscoveredSkill, type SkillSource } from "./discover.js";

/** 自动触发最多注入的技能数（防上下文爆炸） */
const MAX_TRIGGERED = 3;

/**
 * 文件系统技能库（§5.2 渐进加载）：
 * meta() 常驻 system prompt 稳定区（仅名称+描述）；
 * match() 命中后 body() 才读正文（渐进披露）。
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

  meta(): SkillMeta[] {
    return this.#discovered.map((s) => ({
      name: s.manifest.name,
      description: s.manifest.description,
    }));
  }

  async body(name: string): Promise<string> {
    const cached = this.#bodies.get(name);
    if (cached !== undefined) return cached;
    const found = this.#discovered.find((s) => s.manifest.name === name);
    if (found === undefined) {
      throw new Error(`技能不存在: ${name}`);
    }
    const text = await readFile(found.filePath, "utf8");
    const parsedEnd = text.replace(/\r\n/g, "\n").indexOf("\n---\n", 4);
    const body = parsedEnd === -1 ? text : text.slice(parsedEnd + 5).trim();
    this.#bodies.set(name, body);
    return body;
  }

  /** 触发匹配：输入包含任一 trigger（大小写不敏感）；无 triggers 的技能不自动触发 */
  match(input: string): SkillMeta[] {
    const lower = input.toLowerCase();
    const matched = this.#discovered.filter((s) =>
      s.manifest.triggers.some((trigger) => trigger.trim() !== "" && lower.includes(trigger.toLowerCase())),
    );
    return matched
      .sort((a, b) => (a.manifest.name < b.manifest.name ? -1 : 1))
      .slice(0, MAX_TRIGGERED)
      .map((s) => ({ name: s.manifest.name, description: s.manifest.description }));
  }
}

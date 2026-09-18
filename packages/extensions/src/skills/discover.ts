import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { SkillManifest } from "@kcode/contracts";
import { parseSkillMd } from "./parse.js";

export interface SkillSource {
  /** 技能根目录：其下每个子目录是一个技能（含 SKILL.md） */
  dir: string;
  source: "project" | "user" | "builtin" | "plugin";
}

export interface DiscoveredSkill {
  manifest: SkillManifest;
  /** SKILL.md 绝对路径（渐进加载：命中后才读正文） */
  filePath: string;
  source: SkillSource["source"];
}

/**
 * 统一发现入口（§5.4）：按 roots 顺序扫描，同名技能先见者胜——
 * 优先级 project > user > builtin（插件目录 P3 接入）。
 * 单个技能解析失败不阻断整体，收集告警返回。
 */
export async function discoverSkills(
  roots: SkillSource[],
  onWarn?: (message: string) => void,
): Promise<DiscoveredSkill[]> {
  const byName = new Map<string, DiscoveredSkill>();
  for (const root of roots) {
    let entries: Dirent[];
    try {
      entries = await readdir(root.dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在视为无技能
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = join(root.dir, entry.name, "SKILL.md");
      let text: string;
      try {
        text = await readFile(filePath, "utf8");
      } catch {
        onWarn?.(`技能目录 ${entry.name} 缺少 SKILL.md（${root.source}）`);
        continue;
      }
      const parsed = parseSkillMd(text);
      if (!parsed.ok) {
        onWarn?.(`技能 ${entry.name} 解析失败：${parsed.error}（${root.source}）`);
        continue;
      }
      if (parsed.skill.manifest.name !== entry.name) {
        onWarn?.(`技能 ${entry.name} 的 frontmatter name（${parsed.skill.manifest.name}）与目录名不一致，已忽略`);
        continue;
      }
      if (!byName.has(parsed.skill.manifest.name)) {
        byName.set(parsed.skill.manifest.name, {
          manifest: parsed.skill.manifest,
          filePath,
          source: root.source,
        });
      }
    }
  }
  return [...byName.values()].sort((a, b) => (a.manifest.name < b.manifest.name ? -1 : 1));
}

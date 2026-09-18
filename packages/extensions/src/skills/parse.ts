import { SkillManifest, type SkillManifest as SkillManifestType } from "@kcode/contracts";

export interface ParsedSkill {
  manifest: SkillManifestType;
  body: string;
}

/**
 * 解析 SKILL.md：YAML-ish frontmatter（name/description/triggers 列表）+ Markdown 正文。
 * 无依赖手写解析——约定字段少，不值得引入 yaml。
 */
export function parseSkillMd(text: string): { ok: true; skill: ParsedSkill } | { ok: false; error: string } {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { ok: false, error: "缺少 frontmatter（应以 --- 开始）" };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    return { ok: false, error: "frontmatter 未闭合（缺少结尾 ---）" };
  }
  const frontmatter = normalized.slice(4, end);
  const body = normalized.slice(end + 5).trim();

  const fields: Record<string, string | string[]> = {};
  let currentList: string[] | null = null;
  for (const line of frontmatter.split("\n")) {
    if (/^\s+-\s+/.test(line) && currentList !== null) {
      currentList.push(line.replace(/^\s+-\s+/, "").trim());
      continue;
    }
    currentList = null;
    const match = /^([a-zA-Z][a-zA-Z0-9_-]*):\s?(.*)$/.exec(line);
    if (match === null || match[1] === undefined) continue;
    const key = match[1];
    const value = match[2] ?? "";
    if (value === "") {
      const list: string[] = [];
      fields[key] = list;
      currentList = list;
    } else {
      fields[key] = value.trim();
    }
  }

  const manifest = SkillManifest.safeParse({
    name: fields["name"],
    description: fields["description"],
    triggers: Array.isArray(fields["triggers"]) ? fields["triggers"] : [],
  });
  if (!manifest.success) {
    return { ok: false, error: `frontmatter 不合法: ${manifest.error.message}` };
  }
  if (body === "") {
    return { ok: false, error: "正文为空" };
  }
  return { ok: true, skill: { manifest: manifest.data, body } };
}

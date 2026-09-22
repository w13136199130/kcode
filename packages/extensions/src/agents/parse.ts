import { SubagentManifest, type SubagentManifest as SubagentManifestType } from "@kcode/contracts";

export interface ParsedAgent {
  manifest: SubagentManifestType;
  body: string;
}

/**
 * 解析子代理定义 .kcode/agents/<name>.md：
 * frontmatter（description / tools 列表或逗号串 / model）+ Markdown 正文（追加到子代理系统提示）。
 * 与技能同款手写解析——约定字段少，不引入 yaml。
 */
export function parseAgentMd(
  name: string,
  text: string,
): { ok: true; agent: ParsedAgent } | { ok: false; error: string } {
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

  const rawTools = fields["tools"];
  const tools = Array.isArray(rawTools)
    ? rawTools
    : typeof rawTools === "string" && rawTools !== ""
      ? rawTools.split(/[,，]\s*/).filter((t) => t !== "")
      : [];

  const manifest = SubagentManifest.safeParse({
    name,
    description: fields["description"],
    tools,
    model: typeof fields["model"] === "string" && fields["model"] !== "" ? fields["model"] : undefined,
  });
  if (!manifest.success) {
    return { ok: false, error: `frontmatter 不合法: ${manifest.error.message}` };
  }
  if (body === "") {
    return { ok: false, error: "正文为空（子代理需要提示正文）" };
  }
  return { ok: true, agent: { manifest: manifest.data, body } };
}

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
    const value = (match[2] ?? "").trim();
    if (value === "") {
      const list: string[] = [];
      fields[key] = list;
      currentList = list;
    } else if (value.startsWith("[")) {
      // 3-19：内联数组 `tools: [read, grep]`
      fields[key] = value
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map((item) => unquote(item))
        .filter((item) => item !== "");
    } else {
      fields[key] = unquote(value);
    }
  }

  const rawTools = fields["tools"];
  const tools = Array.isArray(rawTools)
    ? rawTools
    : typeof rawTools === "string" && rawTools !== ""
      ? rawTools.split(/[,，]\s*/).filter((t) => t !== "")
      : [];
  const rawDisallowed = fields["disallowedTools"] ?? fields["disallowed-tools"] ?? fields["disallowed_tools"];
  const disallowedTools = Array.isArray(rawDisallowed)
    ? rawDisallowed
    : typeof rawDisallowed === "string" && rawDisallowed !== ""
      ? rawDisallowed.split(/[,，]\s*/).filter((t) => t !== "")
      : [];
  const rawMaxTurns = fields["maxTurns"] ?? fields["max-turns"] ?? fields["max_turns"];
  const maxTurns =
    typeof rawMaxTurns === "string" && /^\d+$/.test(rawMaxTurns) ? Number(rawMaxTurns) : undefined;
  const permissionMode =
    typeof fields["permissionMode"] === "string" && ["plan", "default", "acceptEdits"].includes(fields["permissionMode"])
      ? (fields["permissionMode"] as "plan" | "default" | "acceptEdits")
      : undefined;

  const manifest = SubagentManifest.safeParse({
    name,
    description: fields["description"],
    tools,
    disallowedTools,
    model: typeof fields["model"] === "string" && fields["model"] !== "" ? fields["model"] : undefined,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  });
  if (!manifest.success) {
    return { ok: false, error: `frontmatter 不合法: ${manifest.error.message}` };
  }
  if (body === "") {
    return { ok: false, error: "正文为空（子代理需要提示正文）" };
  }
  return { ok: true, agent: { manifest: manifest.data, body } };
}

function unquote(value: string): string {
  const text = value.trim();
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  return text;
}

import { SkillManifest, type SkillManifest as SkillManifestType } from "@kcode/contracts";

export interface ParsedSkill {
  manifest: SkillManifestType;
  body: string;
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

function parseInlineList(value: string): string[] {
  return value
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((item) => unquote(item))
    .filter((item) => item !== "");
}

/**
 * 解析 SKILL.md：YAML-ish frontmatter + Markdown 正文（3-18 增强）。
 * 支持：
 * - 单行标量（含引号，值内可含 `:`）
 * - 块标量 `description: |` / `>`（多行描述，按缩进去除公共前缀）
 * - 列表：`- item` 或内联 `[a, b]`；quoted 列表项
 * - 布尔：`disable-model-invocation: true/false`
 * 不合法/缺失 name/description 直接报错，单个技能失败不阻断其他技能。
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
  const lines = frontmatter.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }
    const match = /^([a-zA-Z][a-zA-Z0-9_-]*):\s?(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const key = match[1]!;
    const rawValue = (match[2] ?? "").trim();

    // 块标量：收集后续缩进行，`|` 保留换行、`>` 折叠为空格
    if (rawValue === "|" || rawValue === ">") {
      const collected: string[] = [];
      let indent: number | undefined;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const next = lines[j]!;
        if (next.trim() === "") {
          collected.push("");
          continue;
        }
        const leading = /^\s*/.exec(next)?.[0].length ?? 0;
        if (leading === 0) {
          break;
        }
        indent ??= leading;
        collected.push(next.slice(Math.min(indent, leading)));
      }
      fields[key] = rawValue === "|" ? collected.join("\n").trim() : collected.join(" ").replace(/\s+/g, " ").trim();
      i = j - 1;
      continue;
    }

    // 内联数组
    if (rawValue.startsWith("[")) {
      fields[key] = parseInlineList(rawValue);
      continue;
    }

    // 空值 + 后续 `- item` 行 → 列表
    if (rawValue === "") {
      const list: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const item = /^\s*-\s+(.*)$/.exec(lines[j]!);
        if (item === null) {
          break;
        }
        list.push(unquote(item[1] ?? ""));
      }
      fields[key] = list;
      i = j - 1;
      continue;
    }

    fields[key] = unquote(rawValue);
  }

  const triggers = Array.isArray(fields["triggers"])
    ? fields["triggers"]
    : typeof fields["triggers"] === "string" && fields["triggers"] !== ""
      ? parseInlineList(fields["triggers"].replace(/^\[/, "").replace(/\]$/, ""))
      : [];
  const allowedRaw = fields["allowed-tools"] ?? fields["allowed_tools"];
  const allowedTools = Array.isArray(allowedRaw)
    ? allowedRaw
    : typeof allowedRaw === "string" && allowedRaw !== ""
      ? allowedRaw.split(",").map((t) => unquote(t)).filter((t) => t !== "")
      : undefined;
  const disableRaw = fields["disable-model-invocation"] ?? fields["disable_model_invocation"];
  const disableModelInvocation =
    typeof disableRaw === "string" && ["true", "yes", "1"].includes(disableRaw.toLowerCase())
      ? true
      : typeof disableRaw === "string" && ["false", "no", "0"].includes(disableRaw.toLowerCase())
        ? false
        : undefined;

  const manifest = SkillManifest.safeParse({
    name: fields["name"],
    description: fields["description"],
    triggers,
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
  });
  if (!manifest.success) {
    return { ok: false, error: `frontmatter 不合法: ${manifest.error.message}` };
  }
  if (body === "") {
    return { ok: false, error: "正文为空" };
  }
  return { ok: true, skill: { manifest: manifest.data, body } };
}

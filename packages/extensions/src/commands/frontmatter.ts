/**
 * 3-17 命令 frontmatter（CC 兼容）：
 * `---` 之间的 description / argument-hint / allowed-tools / model 解析为元数据，
 * 正文只保留 `---` 之后的内容——frontmatter 不再发给模型。
 * 只实现命令用到的 YAML 子集（标量、内联数组、`- item` 列表），不引入 yaml 依赖。
 */

export interface CommandMeta {
  description?: string;
  argumentHint?: string;
  /** 声明允许的工具（展示/后续执行期约束用；CC 的 allowed-tools） */
  allowedTools?: string[];
  /** 指定模型（展示用；执行期切换由宿主决定） */
  model?: string;
}

export interface ParsedCommandFile {
  meta: CommandMeta;
  body: string;
  /** frontmatter 未闭合等结构问题（调用方决定是否告警） */
  warnings: string[];
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

function splitList(value: string): string[] {
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  return inner
    .split(",")
    .map((item) => unquote(item))
    .filter((item) => item !== "");
}

/** 解析命令文件：frontmatter 元数据 + 正文（CRLF 归一；正文首尾空白裁掉） */
export function parseCommandFile(raw: string): ParsedCommandFile {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { meta: {}, body: normalized.trim(), warnings: [] };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) {
    // 未闭合：剥掉起始标记，避免把 `---` 发给模型
    return {
      meta: {},
      body: lines.slice(1).join("\n").trim(),
      warnings: ["frontmatter 未闭合（缺少结尾 ---）"],
    };
  }

  const meta: CommandMeta = {};
  let listKey: "allowedTools" | undefined;
  for (const line of lines.slice(1, close)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const item = /^-\s+(.*)$/.exec(trimmed);
    if (item !== null && listKey !== undefined) {
      (meta[listKey] ??= []).push(unquote(item[1] ?? ""));
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(trimmed);
    if (pair === null) {
      continue;
    }
    const key = pair[1]!.toLowerCase();
    const value = pair[2] ?? "";
    listKey = undefined;
    if (key === "description") {
      meta.description = unquote(value);
    } else if (key === "argument-hint" || key === "argument_hint") {
      meta.argumentHint = unquote(value);
    } else if (key === "allowed-tools" || key === "allowed_tools") {
      const tools = splitList(value);
      if (tools.length > 0) {
        meta.allowedTools = tools;
      } else {
        listKey = "allowedTools"; // 后续 `- item` 行
      }
    } else if (key === "model") {
      meta.model = unquote(value);
    }
  }
  return { meta, body: lines.slice(close + 1).join("\n").trim(), warnings: [] };
}

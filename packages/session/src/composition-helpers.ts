import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Tool } from "@kcode/contracts";

/**
 * composeSession 的模块级辅助（自 composition.ts 外迁，保 max-lines 门禁）：
 * MCP 配置装载 / AGENTS.md 记忆装载 / --disallowed-tools 归一化与过滤。
 */

/** 读取用户级 MCP 配置；缺失或非法按空处理 */
export async function loadMcpConfigs(kcodeHomeDir: string) {
  try {
    const { McpServersFile } = await import("@kcode/contracts");
    const parsed = McpServersFile.safeParse(JSON.parse(await readFile(join(kcodeHomeDir, "mcp.json"), "utf8")));
    return parsed.success ? parsed.data.servers : [];
  } catch {
    return [];
  }
}

/** 读取并合并项目级/用户级 AGENTS.md 记忆 */
export async function loadAgentsMd(cwd: string, kcodeHomeDir: string): Promise<string | undefined> {
  const sections: string[] = [];
  for (const [label, path] of [
    ["项目", join(cwd, "AGENTS.md")],
    ["用户", join(kcodeHomeDir, "AGENTS.md")],
  ] as const) {
    try {
      const text = await readFile(path, "utf8");
      if (text.trim() !== "") {
        sections.push(`## ${label}级（${path}）\n${text.trim()}`);
      }
    } catch {
      // 文件不存在即跳过
    }
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

/** 归一化 --disallowed-tools 输入（逗号/空白分隔可混用）；空输入返回 undefined（零成本直通） */
export function normalizeDisallowedTools(names: string[] | undefined): Set<string> | undefined {
  if (names === undefined) {
    return undefined;
  }
  const set = new Set(names.flatMap((s) => s.split(/[\s,]+/)).filter((s) => s !== ""));
  return set.size > 0 ? set : undefined;
}

/** 组装期剔除工具：未知名抛错并列出全集——拼错名导致"以为剔除了"比当场报错更糟 */
export function applyDisallowedTools(tools: Tool[], disallowed: Set<string> | undefined): Tool[] {
  if (disallowed === undefined) {
    return tools;
  }
  const unknown = [...disallowed].filter((n) => !tools.some((t) => t.definition.name === n));
  if (unknown.length > 0) {
    throw new Error(
      `disallowed-tools 含未知工具：${unknown.join("、")}；可用：${tools.map((t) => t.definition.name).join("、")}`,
    );
  }
  return tools.filter((t) => !disallowed.has(t.definition.name));
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Tool } from "@kcode/contracts";

/**
 * composeSession 的模块级辅助（自 composition.ts 外迁，保 max-lines 门禁）：
 * MCP 配置装载 / AGENTS.md 记忆装载 / --disallowed-tools 归一化与过滤。
 */

/** 读取 MCP 配置：用户级始终生效；项目级 `.kcode/mcp.json` 需 trust（3-14），同名项目覆盖用户 */
export async function loadMcpConfigs(
  kcodeHomeDir: string,
  opts: { projectDir?: string; trusted?: boolean; onWarn?: (message: string) => void } = {},
) {
  const { McpServersFile } = await import("@kcode/contracts");
  const readServers = async (path: string, label: string) => {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return [];
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      opts.onWarn?.(`${label} MCP 配置不是合法 JSON（${path}）：${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
    const parsed = McpServersFile.safeParse(json);
    if (!parsed.success) {
      opts.onWarn?.(`${label} MCP 配置不合法（${path}）：${parsed.error.issues[0]?.message ?? "未知原因"}`);
      return [];
    }
    return parsed.data.servers;
  };
  const user = await readServers(join(kcodeHomeDir, "mcp.json"), "用户级");
  let project: typeof user = [];
  if (opts.projectDir !== undefined) {
    const path = join(opts.projectDir, ".kcode", "mcp.json");
    if (opts.trusted === true) {
      project = await readServers(path, "项目级");
    } else {
      // 未信任项目：项目级 MCP 会启动任意子进程——只提示不装载
      const exists = await readFile(path, "utf8").then(() => true).catch(() => false);
      if (exists) {
        opts.onWarn?.("项目存在 .kcode/mcp.json 但项目未受信任，已忽略（/trust 可添加信任）");
      }
    }
  }
  // 同名覆盖：项目 > 用户（与 skills/commands 的项目优先一致）
  const byName = new Map(user.map((server) => [server.name, server]));
  for (const server of project) {
    byName.set(server.name, server);
  }
  return [...byName.values()];
}

/**
 * 读取并合并项目级/用户级 AGENTS.md 记忆。
 * P0-0：项目级 AGENTS.md 是未信任仓库的 prompt-injection 面，必须与 skills/hooks 同一 trust 门控；
 * 未信任时只读用户级。
 */
export async function loadAgentsMd(
  cwd: string,
  kcodeHomeDir: string,
  opts: { includeProject?: boolean } = {},
): Promise<string | undefined> {
  const includeProject = opts.includeProject ?? true;
  const sections: string[] = [];
  for (const [label, path] of [
    ["项目", join(cwd, "AGENTS.md")],
    ["用户", join(kcodeHomeDir, "AGENTS.md")],
  ] as const) {
    if (label === "项目" && !includeProject) continue;
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

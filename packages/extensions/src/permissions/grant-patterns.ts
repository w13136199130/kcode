import { CONTROL_OPERATORS } from "./safe-commands.js";

/**
 * 持久放行参数级粒度（N3I-5，v2）：模式从工具名整只放行细化到参数级。
 * - 存储形态：`{ tool, content? }` 对象（v1 纯工具名字符串兼容读取——语义=整工具）
 * - content 三档匹配（zcode permission/service.ts 同款）：
 *   `前缀:*` 词边界前缀 / 含 `*` 通配（全锚定）/ 整串精确
 * - 建议规则（ask「本项目」档自动升级）：bash 按稳定子命令前缀（`npm install:*`）、
 *   edit/write 按目录前缀（`src/legacy/*`）；危险根命令与解析可疑命令只给整串精确。
 * 不移植 zcode 的 shell AST 解析器与命令注册表（数千行）——朴素分词 + 黑名单。
 */

/** 持久放行模式（v2 对象形态；content 缺省 = 整工具放行） */
export interface GrantPattern {
  tool: string;
  content?: string;
}

/**
 * 危险根命令：不生成前缀规则（前缀放行 = 授权一族任意参数，不可逆操作不配）。
 * 含解释器（sh/bash/node/python…——`bash -c:*` 等价整工具放行任意代码）与
 * 包装命令（sudo/env/nohup/time——主体保留包装词，剥壳后的前缀与原始命令永不匹配）。
 */
const DANGEROUS_ROOTS = new Set([
  "rm", "sudo", "chmod", "chown", "dd", "mkfs", "shred", "mv",
  "del", "format", "rd", "rmdir", "kill", "taskkill",
  "shutdown", "poweroff", "reboot", "reg",
  "sh", "bash", "zsh", "powershell", "pwsh", "cmd", "node", "python", "python3",
  "env", "nohup", "time",
]);

/** 解析可疑：变量/命令替换/续行/重定向——语义不可静态判定，只给整串精确 */
const SUSPECT_SYNTAX = /`|\$[A-Za-z_{(]|\\\s*$|[<>]/;

/** content 匹配三档：`前缀:*` 词边界 / 通配全锚定 / 精确 */
export function matchGrantContent(pattern: string, subject: string): boolean {
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    return subject === prefix || subject.startsWith(`${prefix} `) || subject.startsWith(`${prefix}\t`);
  }
  if (pattern.includes("*")) {
    return new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`).test(subject);
  }
  return subject === pattern;
}

/** 模式匹配一次调用：工具名（复用通配语义）+ content（有则按主体匹配） */
export function matchGrantPattern(pattern: GrantPattern, toolName: string, subject?: string): boolean {
  if (!new RegExp(`^${pattern.tool.split("*").map(escapeRegExp).join(".*")}$`).test(toolName)) {
    return false;
  }
  if (pattern.content === undefined) {
    return true;
  }
  return subject !== undefined && matchGrantContent(pattern.content, subject);
}

/** 调用的匹配主体（与建议规则同源归一）：bash=命令串，edit/write=路径（反斜杠归一/剥 ./） */
export function grantSubject(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) {
    return undefined;
  }
  const a = args as { command?: unknown; path?: unknown };
  if (typeof a.command === "string" && a.command !== "") {
    return a.command.trim();
  }
  if (typeof a.path === "string" && a.path !== "") {
    return a.path.replace(/\\/g, "/").replace(/^\.\//, "");
  }
  return undefined;
}

/** 建议的持久放行规则（ask「本项目」档）；null = 该工具不提供参数级建议（回落整工具名） */
export function suggestGrant(call: { tool: string; args: unknown }): GrantPattern | null {
  if (call.tool === "bash") {
    const command = grantSubject(call.args);
    if (command === undefined) {
      return null;
    }
    return { tool: "bash", content: suggestBashContent(command) };
  }
  if (call.tool === "write" || call.tool === "edit") {
    const path = grantSubject(call.args);
    if (path === undefined) {
      return null;
    }
    const slash = path.lastIndexOf("/");
    // 根层文件整串精确；目录内文件 → 目录前缀通配（同目录族文件通常同批信任）
    return slash <= 0 ? { tool: call.tool, content: path } : { tool: call.tool, content: `${path.slice(0, slash)}/*` };
  }
  return null;
}

/** 展示形态（AskPanel 选项文案 / /permissions 清单）：`bash:npm install:*` / `write` */
export function formatGrantPattern(pattern: GrantPattern): string {
  return pattern.content === undefined ? pattern.tool : `${pattern.tool}:${pattern.content}`;
}

/** 解析展示/存储形态（formatGrantPattern 的逆；首冒号切分——工具名模式（mcp__*）不含冒号） */
export function parseGrantPattern(text: string): GrantPattern {
  const idx = text.indexOf(":");
  if (idx === -1) {
    return { tool: text };
  }
  return { tool: text.slice(0, idx), content: text.slice(idx + 1) };
}

/** bash 建议规则：统一前缀 `前缀:*`；危险/可疑/前缀不统一 → 整串精确 */
function suggestBashContent(command: string): string {
  if (SUSPECT_SYNTAX.test(command)) {
    return command;
  }
  const segments = command.split(/\s*(?:&&|\|\||;|\|)\s*/).filter((s) => s !== "");
  const prefixes = segments.map(stablePrefix);
  // 任一段无稳定前缀（危险根/旗标开头）或前缀不统一 → 只放行这条整命令
  const first = prefixes[0];
  if (first === undefined || first === null || prefixes.some((p) => p !== first)) {
    return command;
  }
  return `${first}:*`;
}

/** 单段命令的稳定前缀（首 token，第二 token 非旗标则并入——`git push`、`npm install`）；危险根/空段返回 null */
function stablePrefix(segment: string): string | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0];
  if (first === undefined || first === "" || first.startsWith("-") || DANGEROUS_ROOTS.has(first)) {
    return null;
  }
  const second = tokens[1];
  return second !== undefined && !second.startsWith("-") ? `${first} ${second}` : first;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

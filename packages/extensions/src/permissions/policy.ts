import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  PermissionDecision,
  PermissionEngine,
  ToolDefinition,
} from "@kcode/contracts";
import { matchTool } from "./engine.js";

/**
 * 4-02：项目策略文件（`.kcode/policy.json`）。
 *
 * 设计边界：
 * - **只收紧、不放宽既有 Deny**：deny 覆盖任何模式（含 fullAccess/plan）；ask 把 allow 抬回确认；
 *   allow 只把 ask 降为放行，绝不覆盖 deny/敏感路径/插件规则。
 * - **allow 需项目受信任**：项目目录内的文件不能自授放行；deny/ask 在未信任项目也生效
 *   （收紧方向没有安全风险）。
 * - 优先级：priority 大者先；同优先级 deny > ask > allow（安全侧决胜）。
 * - 语法同时覆盖 bash 与 PowerShell（纯文本前缀，不做 shell AST）：支持 `&&/||/;/|` 分段、
 *   `sudo/env/nohup/time` 包装剥离；解释器内嵌（sh -c）仍是已知边界，见 DESIGN §7。
 */

export type PolicyAction = "allow" | "ask" | "deny";

export interface PolicyRule {
  /** 工具名模式（与权限规则同款 * 通配） */
  tool: string;
  /** bash/PowerShell 命令前缀；字符串或数组（数组任一命中） */
  commandPrefix?: string[];
  /** 文件路径前缀（edit/write/read 等 args.path） */
  pathPrefix?: string[];
  decision: PolicyAction;
  priority: number;
  reason?: string;
}

export interface PolicyLoadResult {
  /** 文件路径（即使不存在也返回，便于提示） */
  path: string;
  exists: boolean;
  rules: PolicyRule[];
  /** 解析/校验错误；非空时引擎 fail-closed（全部 deny） */
  errors: string[];
  /** 未信任项目被忽略的 allow 条数 */
  ignoredAllow: number;
}

const DECISIONS = new Set<PolicyAction>(["allow", "ask", "deny"]);

function asStringArray(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((x) => typeof x === "string")) return value as string[];
  return undefined;
}

/** 读取并校验项目策略；文件不存在 = 空策略（不报错） */
export async function loadPolicy(
  cwd: string,
  projectTrusted: boolean,
): Promise<PolicyLoadResult> {
  const path = join(cwd, ".kcode", "policy.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, exists: false, rules: [], errors: [], ignoredAllow: 0 };
    }
    return {
      path,
      exists: true,
      rules: [],
      errors: [`读取失败：${err instanceof Error ? err.message : String(err)}`],
      ignoredAllow: 0,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    return {
      path,
      exists: true,
      rules: [],
      errors: [`不是合法 JSON：${err instanceof Error ? err.message : String(err)}`],
      ignoredAllow: 0,
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { path, exists: true, rules: [], errors: ["顶层必须是对象"], ignoredAllow: 0 };
  }
  const doc = parsed as { version?: unknown; rules?: unknown };
  if (doc.version !== 1) {
    return { path, exists: true, rules: [], errors: ["version 必须为 1"], ignoredAllow: 0 };
  }
  if (!Array.isArray(doc.rules)) {
    return { path, exists: true, rules: [], errors: ["rules 必须是数组"], ignoredAllow: 0 };
  }

  const rules: PolicyRule[] = [];
  const errors: string[] = [];
  doc.rules.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      errors.push(`rules[${index}] 必须是对象`);
      return;
    }
    const r = entry as Record<string, unknown>;
    if (typeof r.tool !== "string" || r.tool === "") {
      errors.push(`rules[${index}].tool 必须是非空字符串`);
      return;
    }
    if (typeof r.decision !== "string" || !DECISIONS.has(r.decision as PolicyAction)) {
      errors.push(`rules[${index}].decision 必须是 allow/ask/deny`);
      return;
    }
    const commandPrefix = r.commandPrefix === undefined ? undefined : asStringArray(r.commandPrefix);
    const pathPrefix = r.pathPrefix === undefined ? undefined : asStringArray(r.pathPrefix);
    if (r.commandPrefix !== undefined && commandPrefix === undefined) {
      errors.push(`rules[${index}].commandPrefix 必须是字符串或字符串数组`);
      return;
    }
    if (r.pathPrefix !== undefined && pathPrefix === undefined) {
      errors.push(`rules[${index}].pathPrefix 必须是字符串或字符串数组`);
      return;
    }
    const priority = r.priority === undefined ? 0 : r.priority;
    if (typeof priority !== "number" || !Number.isFinite(priority)) {
      errors.push(`rules[${index}].priority 必须是数字`);
      return;
    }
    rules.push({
      tool: r.tool,
      ...(commandPrefix !== undefined ? { commandPrefix } : {}),
      ...(pathPrefix !== undefined ? { pathPrefix } : {}),
      decision: r.decision as PolicyAction,
      priority,
      ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
    });
  });

  if (errors.length > 0) {
    return { path, exists: true, rules: [], errors, ignoredAllow: 0 };
  }
  const ignoredAllow = projectTrusted ? 0 : rules.filter((rule) => rule.decision === "allow").length;
  return {
    path,
    exists: true,
    rules: projectTrusted ? rules : rules.filter((rule) => rule.decision !== "allow"),
    errors: [],
    ignoredAllow,
  };
}

/** 命令归一：折叠空白、转小写（Windows 命令大小写不敏感；deny 侧宁严勿漏） */
function normalizeCommand(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** 去掉常见包装命令（sudo/env/nohup/time/command/exec）；处理 env 赋值与 sudo 选项值 */
function stripWrapper(segment: string): string {
  let text = segment.trim();
  for (;;) {
    const match = /^(sudo|env|nohup|time|command|exec)\s+/i.exec(text);
    if (match === null) break;
    text = text.slice(match[0].length).trim();
    // env/sudo 前置赋值（FOO=bar）与选项（-u root / -p）：各自剥掉
    let changed = true;
    while (changed) {
      changed = false;
      const assignment = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.exec(text);
      if (assignment !== null) {
        text = text.slice(assignment[0].length).trim();
        changed = true;
        continue;
      }
      const option = /^-[^\s]+\s+(?:[^\s-]\S*\s+)?/.exec(text);
      if (option !== null) {
        text = text.slice(option[0].length).trim();
        changed = true;
      }
    }
  }
  return text.trim();
}

/** 命令分段（&&/||/;/|/换行）；不做引号感知——宁可多匹配，不放过可疑段 */
function commandSegments(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||;|\||\n)\s*/)
    .map((segment) => stripWrapper(segment))
    .filter((segment) => segment !== "");
}

/** commandPrefix 匹配：整串或任一分段以该前缀开头（词边界不强制——`rm -rf /` 要命中 `/tmp`） */
export function matchCommandPrefix(command: string, prefix: string): boolean {
  const normalized = normalizeCommand(command);
  const target = normalizeCommand(prefix);
  if (target === "") return false;
  if (normalized.startsWith(target)) return true;
  return commandSegments(normalized).some((segment) => segment.startsWith(target));
}

/** 路径归一：反斜杠转正斜杠、剥 ./、小写 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function matchPathPrefix(path: string, prefix: string): boolean {
  const p = normalizePath(path);
  const target = normalizePath(prefix).replace(/\/+$/, "");
  return target !== "" && (p === target || p.startsWith(`${target}/`));
}

/** 单条规则是否命中调用（tool 通配 + commandPrefix/pathPrefix；两者都给时须同时满足） */
export function matchPolicyRule(rule: PolicyRule, toolName: string, args: unknown): boolean {
  if (!matchTool(rule.tool, toolName)) return false;
  if (rule.commandPrefix !== undefined) {
    if (typeof args !== "object" || args === null) return false;
    const command = (args as { command?: unknown }).command;
    if (typeof command !== "string") return false;
    if (!rule.commandPrefix.some((prefix) => matchCommandPrefix(command, prefix))) return false;
  }
  if (rule.pathPrefix !== undefined) {
    if (typeof args !== "object" || args === null) return false;
    const path = (args as { path?: unknown }).path;
    if (typeof path !== "string") return false;
    if (!rule.pathPrefix.some((prefix) => matchPathPrefix(path, prefix))) return false;
  }
  return true;
}

/** 规则排序：priority 降序；同优先级 deny > ask > allow（安全侧决胜） */
const ACTION_RANK: Record<PolicyAction, number> = { deny: 3, ask: 2, allow: 1 };

export function sortPolicyRules(rules: readonly PolicyRule[]): PolicyRule[] {
  return [...rules].sort((a, b) => b.priority - a.priority || ACTION_RANK[b.decision] - ACTION_RANK[a.decision]);
}

/**
 * 策略引擎：包在既有权限引擎外。
 * - deny：任何模式都拒绝；
 * - ask：deny 保持 deny，其余抬成 ask；
 * - allow：只把 ask 降为 allow，绝不覆盖 deny。
 */
export class PolicyPermissionEngine implements PermissionEngine {
  readonly #inner: PermissionEngine;
  readonly #rules: PolicyRule[];
  readonly #failClosed: boolean;

  constructor(inner: PermissionEngine, result: Pick<PolicyLoadResult, "rules" | "errors">) {
    this.#inner = inner;
    this.#rules = sortPolicyRules(result.rules);
    this.#failClosed = result.errors.length > 0;
  }

  async decide(tool: ToolDefinition, args: unknown): Promise<PermissionDecision> {
    if (this.#failClosed) {
      return "deny";
    }
    const base = await this.#inner.decide(tool, args);
    for (const rule of this.#rules) {
      if (!matchPolicyRule(rule, tool.name, args)) continue;
      if (rule.decision === "deny") return "deny";
      if (rule.decision === "ask") return base === "deny" ? "deny" : "ask";
      return base === "ask" ? "allow" : base;
    }
    return base;
  }
}

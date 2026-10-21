import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolOutput } from "@kcode/contracts";
import { workspaceKey } from "@kcode/shared";

const MAX_RULES = 50;
const MAX_RULE_BODY = 8_000;
const MAX_MEMORY_FILES = 20;

export interface RuleFile {
  name: string;
  source: "user" | "project";
  path: string;
  description?: string;
  paths: string[];
  alwaysApply: boolean;
  body: string;
}

export interface RuleFrontmatter {
  description?: string;
  paths: string[];
  alwaysApply: boolean;
}

function stripQuotes(value: string): string {
  const text = value.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

/** 仅解析 kcode rules 需要的 YAML 子集：description / alwaysApply / paths。 */
export function parseRuleFrontmatter(raw: string): { frontmatter: RuleFrontmatter; body: string } {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: { paths: [], alwaysApply: false }, body: raw.trim() };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) {
    return { frontmatter: { paths: [], alwaysApply: false }, body: raw.trim() };
  }
  const attrs: RuleFrontmatter = { paths: [], alwaysApply: false };
  let inPaths = false;
  for (const line of lines.slice(1, end)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("paths:")) {
      inPaths = true;
      const inline = trimmed.slice("paths:".length).trim();
      if (inline.startsWith("[") && inline.endsWith("]")) {
        attrs.paths.push(
          ...inline
            .slice(1, -1)
            .split(",")
            .map((part) => stripQuotes(part))
            .filter((part) => part !== ""),
        );
      }
      continue;
    }
    if (inPaths && trimmed.startsWith("-")) {
      const value = stripQuotes(trimmed.slice(1));
      if (value !== "") attrs.paths.push(value);
      continue;
    }
    inPaths = false;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = stripQuotes(trimmed.slice(colon + 1));
    if (key === "description") attrs.description = value;
    if (key === "alwaysApply") attrs.alwaysApply = value.toLowerCase() === "true";
  }
  return { frontmatter: attrs, body: lines.slice(end + 1).join("\n").trim() };
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/");
  let out = "^";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]!;
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += ".";
    } else if ("\\^$+.()|{}[]".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`${out}$`);
}

export function ruleMatchesPath(rule: RuleFile, filePath: string, cwd: string): boolean {
  if (rule.paths.length === 0) return false;
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const rel = relative(cwd, absolute).replace(/\\/g, "/");
  return rule.paths.some((pattern) => {
    const normalized = pattern.replace(/\\/g, "/");
    return globToRegExp(normalized).test(rel) || globToRegExp(normalized).test(absolute.replace(/\\/g, "/"));
  });
}

async function readRuleDir(dir: string, source: "user" | "project"): Promise<RuleFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const rules: RuleFile[] = [];
  for (const name of names.filter((n) => n.endsWith(".md")).sort().slice(0, MAX_RULES)) {
    const path = join(dir, name);
    try {
      const raw = await readFile(path, "utf8");
      const { frontmatter, body } = parseRuleFrontmatter(raw);
      if (body === "") continue;
      rules.push({
        name: name.replace(/\.md$/, ""),
        source,
        path,
        ...(frontmatter.description !== undefined ? { description: frontmatter.description } : {}),
        paths: frontmatter.paths,
        alwaysApply: frontmatter.alwaysApply,
        body: body.slice(0, MAX_RULE_BODY),
      });
    } catch {
      // 单条规则损坏不影响其它规则
    }
  }
  return rules;
}

/** 用户规则始终加载；项目规则仅在项目已 trust 时加载（prompt-injection 门控）。 */
export async function loadRules(opts: {
  cwd: string;
  kcodeHomeDir: string;
  trusted: boolean;
}): Promise<RuleFile[]> {
  const user = await readRuleDir(join(opts.kcodeHomeDir, "rules"), "user");
  const project = opts.trusted ? await readRuleDir(join(opts.cwd, ".kcode", "rules"), "project") : [];
  return [...user, ...project];
}

export function matchingRules(rules: readonly RuleFile[], filePath: string, cwd: string): RuleFile[] {
  return rules.filter((rule) => ruleMatchesPath(rule, filePath, cwd));
}

export function renderAlwaysRules(rules: readonly RuleFile[], maxChars: number): string {
  const sections: string[] = [];
  let used = 0;
  for (const rule of rules.filter((r) => r.alwaysApply)) {
    const block = `### ${rule.name}（${rule.source}）\n${rule.body}`;
    if (used + block.length > maxChars) break;
    sections.push(block);
    used += block.length;
  }
  return sections.join("\n\n");
}

export function renderRuleIndex(rules: readonly RuleFile[]): string {
  return rules
    .filter((rule) => !rule.alwaysApply)
    .map((rule) => {
      const paths = rule.paths.length > 0 ? ` · paths: ${rule.paths.join(", ")}` : "";
      const desc = rule.description !== undefined ? ` · ${rule.description}` : "";
      return `- ${rule.name}（${rule.source}）${desc}${paths}`;
    })
    .join("\n");
}

/** 项目级自动记忆目录：~/.kcode/projects/<key>/memory/（用户私有，不随仓库提交）。 */
export function projectMemoryDir(kcodeHomeDir: string, cwd: string): string {
  const key = workspaceKey(cwd).replace(/[^A-Za-z0-9._-]+/g, "_");
  return join(kcodeHomeDir, "projects", key, "memory");
}

/** 追加一条项目记忆（模型/用户显式保存；不自动改写 AGENTS.md）。 */
export async function appendProjectMemory(kcodeHomeDir: string, cwd: string, text: string): Promise<string> {
  const clean = text.trim();
  if (clean === "") throw new Error("记忆内容不能为空");
  const dir = projectMemoryDir(kcodeHomeDir, cwd);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "notes.md");
  await appendFile(path, `\n- ${clean}\n`, "utf8");
  return path;
}

/** 项目级自动记忆：~/.kcode/projects/<key>/memory/*.md（用户私有，不随仓库提交）。 */
export async function loadProjectMemory(kcodeHomeDir: string, cwd: string): Promise<string | undefined> {
  const dir = projectMemoryDir(kcodeHomeDir, cwd);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const sections: string[] = [];
  for (const name of names.filter((n) => n.endsWith(".md")).sort().slice(0, MAX_MEMORY_FILES)) {
    try {
      const text = (await readFile(join(dir, name), "utf8")).trim();
      if (text !== "") sections.push(`### ${name.replace(/\.md$/, "")}\n${text}`);
    } catch {
      // 单文件读取失败不影响其它记忆
    }
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

const MemoryArgs = z.object({
  action: z.enum(["list", "add"]),
  text: z.string().optional(),
});

/** 项目自动记忆工具：list 读回已存记忆；add 追加一条（写操作，走权限确认）。 */
export function createMemoryTool(opts: { kcodeHomeDir: string; cwd: string }): Tool {
  return {
    definition: {
      name: "memory",
      description: "项目自动记忆：action=list 读取；action=add + text 追加一条偏好/约定（保存在用户私有目录，不写 AGENTS.md）",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "add"] },
          text: { type: "string", description: "add 时要记住的内容" },
        },
        required: ["action"],
      },
      readOnly: false,
      permission: { default: "ask" },
      timeoutMs: 10_000,
    },
    async execute(input: unknown): Promise<ToolOutput> {
      const parsed = MemoryArgs.safeParse(input);
      if (!parsed.success) return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
      if (parsed.data.action === "list") {
        const text = await loadProjectMemory(opts.kcodeHomeDir, opts.cwd);
        return {
          ok: true,
          output: `记忆目录：${projectMemoryDir(opts.kcodeHomeDir, opts.cwd)}\n${text ?? "（暂无项目记忆）"}`,
        };
      }
      if (parsed.data.text === undefined || parsed.data.text.trim() === "") {
        return { ok: false, output: "", error: "action=add 需要 text" };
      }
      const path = await appendProjectMemory(opts.kcodeHomeDir, opts.cwd, parsed.data.text);
      return { ok: true, output: `已记住（${path}）：${parsed.data.text.trim()}` };
    },
  };
}

const RulesArgs = z.object({
  path: z.string().optional(),
  name: z.string().optional(),
});

/** 按路径加载路径作用域规则正文；无参数时列出规则索引。 */
export function createRulesTool(opts: { rules: readonly RuleFile[]; cwd: string }): Tool {
  return {
    definition: {
      name: "rules",
      description: "查看项目/用户规则；path=文件路径 时只返回命中该路径的规则正文（路径作用域按需加载）",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "目标文件路径；返回命中该路径的规则" },
          name: { type: "string", description: "规则名（省略则按 path 或列出索引）" },
        },
      },
      readOnly: true,
      permission: { default: "allow" },
      timeoutMs: 10_000,
    },
    async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
      const parsed = RulesArgs.safeParse(input);
      if (!parsed.success) return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
      const { path, name } = parsed.data;
      if (name !== undefined) {
        const rule = opts.rules.find((r) => r.name === name || r.name.startsWith(name));
        return rule === undefined
          ? { ok: false, output: "", error: `未找到规则：${name}` }
          : { ok: true, output: `### ${rule.name}（${rule.source}）\n${rule.body}` };
      }
      if (path !== undefined) {
        const matched = matchingRules(opts.rules, path, ctx.cwd ?? opts.cwd);
        return matched.length === 0
          ? { ok: true, output: `（没有命中 ${path} 的规则）` }
          : {
              ok: true,
              output: matched.map((rule) => `### ${rule.name}（${rule.source}）\n${rule.body}`).join("\n\n"),
            };
      }
      const index = renderRuleIndex(opts.rules);
      return { ok: true, output: index === "" ? "（没有路径作用域规则）" : index };
    },
  };
}

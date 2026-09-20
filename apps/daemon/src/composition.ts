import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ChatMessage,
  LLMProvider,
  PermissionAsker,
  SessionEvent,
  SessionSink,
  UserPromptPort,
} from "@kcode/contracts";
import { AgentLoop, InMemoryToolRegistry, MemoryAudit } from "@kcode/core";
import {
  CommandLibrary,
  DEFAULT_RULES,
  FsSkillLibrary,
  MutablePermissionEngine,
  ProcessHookRunner,
  READONLY_RULES,
  RuleBasedPermissionEngine,
  listInstalledPlugins,
  loadHookConfigs,
  trustProject as trustProjectOnFile,
} from "@kcode/extensions";
import { JsonlSessionSink, createSessionsTool, listSessions, loadSessionEvents, rebuildHistory } from "@kcode/runtime";
import { LlmSummarizer } from "@kcode/platform";
import { newId } from "@kcode/shared";
import { connectMcpServers, createSessionTools } from "@kcode/tools";

export const SYSTEM_PROMPT = `你是 kcode（快码），本地优先的代码助手。
- 回答代码问题前先用工具查证（read/glob/grep），结论引用 file:line；
- 不知道就说不知道，不臆造文件与符号；
- 多步骤任务用 todo 工具维护任务清单；需要用户决策时用 ask_user 提选择题；
- 回答简洁，中文。`;

export const PLAN_MODE_SUFFIX = `

【计划模式】只读研究：可用读工具调研，不得修改文件或执行有副作用的命令；
产出一份明确的执行计划并等待用户确认，用户用 /plan off 切回执行模式。`;

export interface ComposedSession {
  loop: AgentLoop;
  sessionId: string;
  jsonlPath: string;
  setPlanMode(on: boolean): void;
  listCommands(): { name: string; source: "project" | "user" }[];
  expandCommand(name: string, args: string): Promise<string | null>;
  close(): Promise<void>;
}

export interface ComposeSessionOptions {
  llm: LLMProvider;
  model: string;
  cwd: string;
  /** kcode 主目录（默认 ~/.kcode，测试可注入临时目录） */
  kcodeHomeDir: string;
  /** 续接种子历史（由调用方从旧会话重建） */
  resumeFrom?: ChatMessage[];
  onEvent?: (event: SessionEvent) => void;
  onDelta?: (delta: string) => void;
  onNotice?: (message: string) => void;
  asker?: PermissionAsker;
  askUser?: UserPromptPort;
}

/** 读取用户级 MCP 配置；缺失或非法按空处理 */
async function loadMcpConfigs(kcodeHomeDir: string) {
  try {
    const { McpServersFile } = await import("@kcode/contracts");
    const parsed = McpServersFile.safeParse(JSON.parse(await readFile(join(kcodeHomeDir, "mcp.json"), "utf8")));
    return parsed.success ? parsed.data.servers : [];
  } catch {
    return [];
  }
}

/** 读取并合并项目级/用户级 AGENTS.md 记忆 */
async function loadAgentsMd(cwd: string, kcodeHomeDir: string): Promise<string | undefined> {
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

/**
 * 会话组装（守护进程是唯一组装点）：工具、权限、钩子、技能、命令、
 * MCP、记忆与摘要器在此聚合，外部只传入模型与回调。
 */
export async function composeSession(opts: ComposeSessionOptions): Promise<ComposedSession> {
  const sessionId = newId("sess");
  const jsonlPath = join(opts.kcodeHomeDir, "cli", "sessions", `${sessionId}.jsonl`);
  const disk = await JsonlSessionSink.open(jsonlPath);
  const sink: SessionSink = {
    append: async (event) => {
      opts.onEvent?.(event);
      await disk.append(event);
    },
  };
  const permissions = new MutablePermissionEngine(
    new RuleBasedPermissionEngine({ rules: DEFAULT_RULES, fallback: "deny" }),
  );
  const agentsMd = await loadAgentsMd(opts.cwd, opts.kcodeHomeDir);

  // 已安装插件：技能/命令/MCP 追加装载（skills 与 commands 以插件目录为额外根）
  const plugins = await listInstalledPlugins(join(opts.kcodeHomeDir, "cli", "plugins", "cache"));
  const pluginSkillRoots = plugins.map((p) => ({
    dir: join(p.installPath, "skills"),
    source: "plugin" as const,
  }));
  const pluginCommandRoots = plugins.map((p) => ({
    dir: join(p.installPath, "commands"),
    source: "project" as const,
  }));

  const skills = await FsSkillLibrary.open(
    [
      { dir: join(opts.cwd, ".kcode", "skills"), source: "project" },
      { dir: join(opts.kcodeHomeDir, "skills"), source: "user" },
      ...pluginSkillRoots,
    ],
    opts.onNotice,
  );
  const hookConfigs = await loadHookConfigs({
    userDir: opts.kcodeHomeDir,
    projectDir: opts.cwd,
    trustFile: join(opts.kcodeHomeDir, "trusted-projects.json"),
    onWarn: opts.onNotice,
  });
  const hooks = new ProcessHookRunner(hookConfigs, { sessionId, onWarn: opts.onNotice });
  const commands = await CommandLibrary.open(
    [
      { dir: join(opts.cwd, ".kcode", "commands"), source: "project" },
      { dir: join(opts.kcodeHomeDir, "commands"), source: "user" },
      ...pluginCommandRoots,
    ],
    opts.onNotice,
  );
  const mcpSessions = await connectMcpServers(await loadMcpConfigs(opts.kcodeHomeDir), {
    onWarn: opts.onNotice,
  });
  const pluginMcpConfigs = plugins.flatMap((p) =>
    p.manifest.mcp.map((m) => ({
      name: m.name,
      transport: "stdio" as const,
      command: m.command ?? "node",
      args: m.url !== undefined ? [m.url] : [],
    })),
  );
  const pluginMcpSessions = await connectMcpServers(pluginMcpConfigs, { onWarn: opts.onNotice });
  if (plugins.length > 0) {
    opts.onNotice?.(`已装载 ${plugins.length} 个插件：${plugins.map((p) => `${p.manifest.name}@${p.manifest.version}`).join("、")}`);
  }
  const loop = new AgentLoop(
    {
      llm: opts.llm,
      tools: new InMemoryToolRegistry([
        ...createSessionTools({
          sessionId,
          artifactsDir: join(opts.kcodeHomeDir, "cli", "artifacts", sessionId),
          onNotice: opts.onNotice,
          sink,
          prompt: opts.askUser,
        }),
        createSessionsTool({ sessionsDir: join(opts.kcodeHomeDir, "cli", "sessions") }),
        ...mcpSessions.flatMap((s) => s.tools),
        ...pluginMcpSessions.flatMap((s) => s.tools),
      ]),
      permissions,
      hooks,
      sink,
      audit: new MemoryAudit().sink,
      asker: opts.asker,
      onDelta: opts.onDelta,
      skills,
      summarizer: new LlmSummarizer(opts.llm, opts.model),
    },
    {
      sessionId,
      model: opts.model,
      systemPrompt: SYSTEM_PROMPT,
      cwd: opts.cwd,
      agentsMd,
      initialHistory: opts.resumeFrom,
      maxTurns: 24,
    },
  );
  return {
    loop,
    sessionId,
    jsonlPath,
    setPlanMode: (on) => {
      permissions.set(
        new RuleBasedPermissionEngine({ rules: on ? READONLY_RULES : DEFAULT_RULES, fallback: "deny" }),
      );
      loop.updateSystemPrompt(SYSTEM_PROMPT + (on ? PLAN_MODE_SUFFIX : ""));
    },
    listCommands: () => commands.list().map((c) => ({ name: c.name, source: c.source })),
    expandCommand: (name, args) => commands.expand(name, args),
    close: async () => {
      await Promise.all([...mcpSessions, ...pluginMcpSessions].map((s) => s.close()));
    },
  };
}

/** 解析续接来源（latest / id 前缀 / 精确 id），返回种子历史；找不到返回 null */
export async function resolveResumeHistory(
  kcodeHomeDir: string,
  resumeFrom: string,
): Promise<ChatMessage[] | null> {
  const sessionsDir = join(kcodeHomeDir, "cli", "sessions");
  const summaries = await listSessions(sessionsDir);
  if (summaries.length === 0) {
    return null;
  }
  const target =
    resumeFrom === "latest"
      ? summaries[0]
      : summaries.find((s) => s.sessionId === resumeFrom || s.sessionId.startsWith(resumeFrom));
  if (target === undefined) {
    return null;
  }
  return rebuildHistory(await loadSessionEvents(target.filePath));
}

/** 把项目写入受信任清单（幂等） */
export function trustProject(cwd: string, kcodeHomeDir: string): Promise<void> {
  return trustProjectOnFile(cwd, join(kcodeHomeDir, "trusted-projects.json"));
}

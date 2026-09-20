import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ChatMessage,
  LLMProvider,
  PermissionAsker,
  PermissionMode,
  SessionEvent,
  SessionSink,
  ToolCallRef,
  UserPromptPort,
} from "@kcode/contracts";
import { normalizePermissionAnswer } from "@kcode/contracts";
import { AgentLoop, InMemoryToolRegistry, MemoryAudit } from "@kcode/core";
import {
  CommandLibrary,
  DEFAULT_RULES,
  FsSkillLibrary,
  MutablePermissionEngine,
  ProcessHookRunner,
  RULES_BY_MODE,
  RuleBasedPermissionEngine,
  listInstalledPlugins,
  loadHookConfigs,
  trustProject as trustProjectOnFile,
} from "@kcode/extensions";
import { JsonlSessionSink, createSessionsTool, listSessions, loadSessionEvents, rebuildHistory } from "@kcode/runtime";
import { LlmSummarizer } from "@kcode/platform";
import { newId } from "@kcode/shared";
import { connectMcpServers, createSessionTools, currentShellInfo } from "@kcode/tools";

export const SYSTEM_PROMPT = `你是 kcode（快码），本地优先的代码助手。
- 涉及本项目代码的问题先用工具查证（read/glob/grep），结论引用 file:line；能力介绍/常识问答/闲聊不需要工具，直接回答；
- 不知道就说不知道，不臆造文件与符号；同一查询不重复发起，失败先换思路而不是原样重试；
- 多步骤任务用 todo 工具维护任务清单；需要用户决策时用 ask_user 提选择题；
- 回答简洁，中文。`;

export const PLAN_MODE_SUFFIX = `

【计划模式】只读研究：可用读工具调研，不得修改文件或执行有副作用的命令；
产出一份明确的执行计划并等待用户确认，用户用 /mode default 切回执行模式。`;

export interface ComposedSession {
  loop: AgentLoop;
  sessionId: string;
  jsonlPath: string;
  /** 中断当前运行（Esc abort）：流式立即停止、未开始的工具调用取消 */
  abort(): void;
  /** 切换权限模式四档（plan/default/acceptEdits/fullAccess） */
  setMode(mode: PermissionMode): void;
  /** 运行期换模型（/model）：重建 LLM 与摘要器，历史保留；解析失败抛错 */
  setModel(model: string): Promise<void>;
  listCommands(): { name: string; source: "project" | "user" }[];
  expandCommand(name: string, args: string): Promise<string | null>;
  listSkills(): { name: string; description: string; source: string }[];
  skillBody(name: string): Promise<string | null>;
  close(): Promise<void>;
}

export interface ComposeSessionOptions {
  /** 模型工厂：session_set_model 运行期换模型时重建 LLM（路由/keychain 校验走同一路径） */
  llmFactory: (model: string) => Promise<LLMProvider>;
  model: string;
  cwd: string;
  /** kcode 主目录（默认 ~/.kcode，测试可注入临时目录） */
  kcodeHomeDir: string;
  /** 续接种子历史（由调用方从旧会话重建） */
  resumeFrom?: ChatMessage[];
  onEvent?: (event: SessionEvent) => void;
  onDelta?: (delta: string) => void;
  /** 思考过程增量（reasoning 模型）：与 onDelta 平行的瞬态通道 */
  onReasoning?: (delta: string) => void;
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
  // asker 装饰：归一化应答；scope=session 时按工具名记会话级放行
  const baseAsker = opts.asker;
  const asker: PermissionAsker | undefined =
    baseAsker === undefined
      ? undefined
      : {
          confirm: async (call: ToolCallRef) => {
            const answer = normalizePermissionAnswer(await baseAsker.confirm(call));
            if (answer.allowed && answer.scope === "session") {
              permissions.grant(call.tool);
            }
            return answer;
          },
        };
  const agentsMd = await loadAgentsMd(opts.cwd, opts.kcodeHomeDir);
  // 运行环境块（对标 Claude Code <env> 注入）：模型不再猜 shell 方言/平台，避免补偿式重试
  const shell = await currentShellInfo();
  const basePrompt = `${SYSTEM_PROMPT}

<env>
OS=${process.platform} · shell=${shell.dialect} · cwd=${opts.cwd}
</env>`;

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
  const initialLlm = await opts.llmFactory(opts.model);
  const loop = new AgentLoop(
    {
      llm: initialLlm,
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
      asker,
      onDelta: opts.onDelta,
      onReasoning: opts.onReasoning,
      skills,
      summarizer: new LlmSummarizer(initialLlm, opts.model),
    },
    {
      sessionId,
      model: opts.model,
      systemPrompt: basePrompt,
      cwd: opts.cwd,
      agentsMd,
      initialHistory: opts.resumeFrom,
      maxTurns: 24,
    },
  );
  // 当前运行的 abort 控制器（会话内串行运行；run 结束自动清空）
  let activeAbort: AbortController | null = null;
  const rawLoopRun = loop.run.bind(loop);
  loop.run = (input: string, runOpts: { images?: string[] } = {}) => {
    const controller = new AbortController();
    activeAbort = controller;
    return rawLoopRun(input, { ...runOpts, signal: controller.signal }).finally(() => {
      activeAbort = null;
    });
  };
  return {
    loop,
    sessionId,
    jsonlPath,
    abort: () => {
      activeAbort?.abort();
    },
    setMode: (mode: PermissionMode) => {
      // 切入 plan 档清空会话级放行：只读姿态不被历史放行打穿
      if (mode === "plan") {
        permissions.clearGrants();
      }
      permissions.set(
        new RuleBasedPermissionEngine({ rules: RULES_BY_MODE[mode], fallback: "deny" }),
      );
      loop.updateSystemPrompt(basePrompt + (mode === "plan" ? PLAN_MODE_SUFFIX : ""));
    },
    setModel: async (model) => {
      const llm = await opts.llmFactory(model);
      loop.updateModel(model, llm, new LlmSummarizer(llm, model));
    },
    listCommands: () => commands.list().map((c) => ({ name: c.name, source: c.source })),
    expandCommand: (name, args) => commands.expand(name, args),
    listSkills: () => skills.meta().map((s) => ({ name: s.name, description: s.description, source: "" })),
    skillBody: (name) => skills.body(name).catch(() => null),
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

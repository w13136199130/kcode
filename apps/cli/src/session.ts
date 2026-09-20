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
import { McpServersFile } from "@kcode/contracts";
import { AgentLoop, InMemoryToolRegistry, MemoryAudit } from "@kcode/core";
import {
  CommandLibrary,
  DEFAULT_RULES,
  FsSkillLibrary,
  MutablePermissionEngine,
  ProcessHookRunner,
  READONLY_RULES,
  RuleBasedPermissionEngine,
  loadHookConfigs,
  trustProject as trustProjectOnFile,
} from "@kcode/extensions";
import { createSessionsTool, JsonlSessionSink } from "@kcode/runtime";
import { LlmSummarizer } from "@kcode/platform";
import { newId } from "@kcode/shared";
import { connectMcpServers, createSessionTools } from "@kcode/tools";
import { kcodeHome } from "./bootstrap.js";

export const SYSTEM_PROMPT = `你是 kcode（快码），本地优先的代码助手。
- 回答代码问题前先用工具查证（read/glob/grep），结论引用 file:line；
- 不知道就说不知道，不臆造文件与符号；
- 多步骤任务用 todo 工具维护任务清单；需要用户决策时用 ask_user 提选择题；
- 回答简洁，中文。`;

export const PLAN_MODE_SUFFIX = `

【计划模式】只读研究：可用读工具调研，不得修改文件或执行有副作用的命令；
产出一份明确的执行计划并等待用户确认，用户用 /plan off 切回执行模式。`;

export interface SessionHandle {
  loop: AgentLoop;
  sessionId: string;
  /** 会话 JSONL 落盘路径（append-only，回放/续接复用） */
  jsonlPath: string;
  /** 计划模式切换：readonly 权限 + 计划 system prompt */
  setPlanMode(on: boolean): void;
  /** 已发现的斜杠命令（供 /help 展示） */
  listCommands(): { name: string; source: "project" | "user" }[];
  /** 展开自定义命令模板；不存在返回 null */
  expandCommand(name: string, args: string): Promise<string | null>;
  /** 把当前项目写入受信任清单（项目级 hooks/技能的门控前提） */
  trustProject(): Promise<void>;
}

/** AGENTS.md 记忆（§5.3）：项目级优先，用户级追加，均缺失则 undefined */
export async function loadAgentsMd(cwd: string): Promise<string | undefined> {
  const sections: string[] = [];
  for (const [label, path] of [
    ["项目", join(cwd, "AGENTS.md")],
    ["用户", join(kcodeHome(), "AGENTS.md")],
  ] as const) {
    try {
      const text = await readFile(path, "utf8");
      if (text.trim() !== "") {
        sections.push(`## ${label}级（${path}）\n${text.trim()}`);
      }
    } catch {
      // 不存在即跳过
    }
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

/**
 * 建会话：AgentLoop + 会话工具全集（读放行，写/bash 经 ask 确认——§7 默认预设），
 * 事件双写——onEvent 实时渲染、JSONL 落盘 ~/.kcode/cli/sessions/；
 * onDelta 流式增量、onNotice 后台任务/技能告警通知（瞬态，不落盘）；
 * AGENTS.md 记忆 + SKILL.md 渐进加载/自动触发（P2-1/2-2）。
 */
export async function createSession(opts: {
  llm: LLMProvider;
  model: string;
  cwd: string;
  onEvent?: (event: SessionEvent) => void;
  onDelta?: (delta: string) => void;
  onNotice?: (message: string) => void;
  asker?: PermissionAsker;
  askUser?: UserPromptPort;
  /** 续接种子历史（--resume：由旧会话 JSONL 重建，新会话即其分支，§5.3） */
  resumeFrom?: ChatMessage[];
}): Promise<SessionHandle> {
  const sessionId = newId("sess");
  const jsonlPath = join(kcodeHome(), "cli", "sessions", `${sessionId}.jsonl`);
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
  const agentsMd = await loadAgentsMd(opts.cwd);
  const skills = await FsSkillLibrary.open(
    [
      { dir: join(opts.cwd, ".kcode", "skills"), source: "project" },
      { dir: join(kcodeHome(), "skills"), source: "user" },
    ],
    opts.onNotice,
  );
  // 钩子：用户级始终生效，项目级需项目受信任（防止克隆仓库自动执行命令）
  const hookConfigs = await loadHookConfigs({
    userDir: kcodeHome(),
    projectDir: opts.cwd,
    trustFile: join(kcodeHome(), "trusted-projects.json"),
    onWarn: opts.onNotice,
  });
  const hooks = new ProcessHookRunner(hookConfigs, { sessionId, onWarn: opts.onNotice });
  // 斜杠命令：项目级覆盖用户级同名命令
  const commands = await CommandLibrary.open(
    [
      { dir: join(opts.cwd, ".kcode", "commands"), source: "project" },
      { dir: join(kcodeHome(), "commands"), source: "user" },
    ],
    opts.onNotice,
  );
  // MCP 服务器：独立进程接入，单个失败不阻断会话
  const mcpSessions = await connectMcpServers(await loadMcpConfigs(), { onWarn: opts.onNotice });
  const mcpTools = mcpSessions.flatMap((s) => s.tools);
  const loop = new AgentLoop(
    {
      llm: opts.llm,
      tools: new InMemoryToolRegistry([
        ...createSessionTools({
          sessionId,
          artifactsDir: join(kcodeHome(), "cli", "artifacts", sessionId),
          onNotice: opts.onNotice,
          sink,
          prompt: opts.askUser,
        }),
        createSessionsTool({ sessionsDir: join(kcodeHome(), "cli", "sessions") }),
        ...mcpTools,
      ]),
      permissions,
      hooks,
      sink,
      audit: new MemoryAudit().sink,
      asker: opts.asker,
      onDelta: opts.onDelta,
      skills,
      // 历史压缩摘要器：复用会话模型；后续可按任务路由到更便宜的模型实例
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
  const setPlanMode = (on: boolean): void => {
    permissions.set(
      new RuleBasedPermissionEngine({
        rules: on ? READONLY_RULES : DEFAULT_RULES,
        fallback: "deny",
      }),
    );
    loop.updateSystemPrompt(SYSTEM_PROMPT + (on ? PLAN_MODE_SUFFIX : ""));
  };
  return {
    loop,
    sessionId,
    jsonlPath,
    setPlanMode,
    listCommands: () => commands.list().map((c) => ({ name: c.name, source: c.source })),
    expandCommand: (name, args) => commands.expand(name, args),
    trustProject: () => trustProjectOnFile(opts.cwd, join(kcodeHome(), "trusted-projects.json")),
  };
}

/** 读取用户级 MCP 配置（~/.kcode/mcp.json）；缺失或非法按空处理 */
async function loadMcpConfigs() {
  const path = join(kcodeHome(), "mcp.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = McpServersFile.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return [];
    }
    return parsed.data.servers;
  } catch {
    return [];
  }
}

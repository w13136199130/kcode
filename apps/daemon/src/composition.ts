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
import { AgentLoop, InMemoryToolRegistry, MemoryAudit, type SessionUsage } from "@kcode/core";
import {
  AgentLibrary,
  CommandLibrary,
  DEFAULT_RULES,
  FsSkillLibrary,
  MutablePermissionEngine,
  ProcessHookRunner,
  ProjectGrantStore,
  READONLY_RULES,
  RULES_BY_MODE,
  RuleBasedPermissionEngine,
  listInstalledPlugins,
  loadHookConfigs,
  trustProject as trustProjectOnFile,
} from "@kcode/extensions";
import { JsonlSessionSink, createSessionsTool, listSessions, loadSessionEvents, rebuildHistory } from "@kcode/runtime";
import { LlmSummarizer } from "@kcode/platform";
import { newId } from "@kcode/shared";
import { connectMcpServers, createBashTool, createSessionTools, createWebTools, currentShellInfo, resolveInCtx } from "@kcode/tools";
import { buildTaskTool } from "./subagent.js";
import { buildPlanSubmitTool, type PlanVerdict } from "./plan-submit.js";
import { CheckpointStore, withFileCheckpoints } from "./checkpoints.js";

export const SYSTEM_PROMPT = `你是 kcode（快码），本地优先的代码助手。
- 涉及本项目代码的问题先用工具查证（read/glob/grep），结论引用 file:line；能力介绍/常识问答/闲聊不需要工具，直接回答；
- 读 PDF/DOCX/XLSX/图片一律用 extract 工具（read 只管文本文件）；
- 需要网络资料时用 web_search 搜索、web_fetch 抓取（引用来源 URL）；
- 不知道就说不知道，不臆造文件与符号；同一查询不重复发起，失败先换思路而不是原样重试；
- 多步骤任务用 todo 工具维护任务清单；需要用户决策时用 ask_user 提选择题；
- 回答简洁，中文。`;

export const PLAN_MODE_SUFFIX = `

【计划模式】只读研究：可用读工具调研，不得修改文件或执行有副作用的命令；
产出完整计划（目标/步骤/涉及文件/风险）后调用 plan_submit 工具提交等待用户批准——
批准后自动切回执行模式；用户要求继续研究则补充调研后重新提交。`;

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
  /** 本项目持久放行清单（/permissions） */
  listPersistentGrants(): Promise<string[]>;
  /** 清空本项目持久放行，返回清除条数（/permissions） */
  clearPersistentGrants(): Promise<number>;
  /** 会话累计用量（含 resume 种子；/cost） */
  usageSummary(): SessionUsage;
  /** /rewind 回退点清单（每个 user_message 一项；fileChanges = 其后的写/编辑次数） */
  listRewindPoints(): Promise<{ eventIndex: number; preview: string; ts: number; fileChanges: number }[]>;
  /** 回退到某个 user_message 之前：恢复文件快照（逆序）+ 以事件重建截断历史；运行中拒绝 */
  rewind(eventIndex: number): Promise<{ restoredFiles: number; droppedEvents: number }>;
  /** /compact 手动压缩 */
  compactNow(): Promise<{ dropped: number; summaryChars: number } | null>;
  /** !命令 用户直执行（不经 LLM、不问权限；结果仅返回显示） */
  runBash(command: string, timeoutMs?: number): Promise<{ ok: boolean; output: string; error?: string; durationMs: number }>;
  /** /context 上下文占用 */
  contextStats(): {
    model: string;
    contextWindow: number;
    historyTokens: number;
    historyBudget: number;
    systemTokens: number;
    pinnedAnchor: boolean;
  };
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
  /** 续接的历史累计用量（旧会话 session_end 求和；/cost 跨续接可见） */
  resumeUsage?: SessionUsage;
  onEvent?: (event: SessionEvent) => void;
  onDelta?: (delta: string) => void;
  /** 思考过程增量（reasoning 模型）：与 onDelta 平行的瞬态通道 */
  onReasoning?: (delta: string) => void;
  onNotice?: (message: string) => void;
  asker?: PermissionAsker;
  askUser?: UserPromptPort;
  /** 计划批准交互（plan_submit 工具，B2）：daemon 注入，推 plan_question 给客户端 */
  planAsker?: { ask(plan: string): Promise<PlanVerdict> };
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
  // 项目级持久放行库（ask 时点查询：plan 档 deny 规则先生效，持久放行只跳过询问）
  const grantStore = ProjectGrantStore.open(join(opts.kcodeHomeDir, "permissions.json"), opts.cwd);
  const persistentGrants = await grantStore.list();
  if (persistentGrants.length > 0) {
    opts.onNotice?.(
      `本项目有 ${persistentGrants.length} 项持久放行（${persistentGrants.join("、")}）——/permissions 查看或清除`,
    );
  }
  // asker 装饰：归一化应答；scope=session 记会话级放行，scope=project 落盘持久放行；
  // 命中持久放行的工具直接免问放行
  const baseAsker = opts.asker;
  const asker: PermissionAsker | undefined =
    baseAsker === undefined
      ? undefined
      : {
          confirm: async (call: ToolCallRef) => {
            if (await grantStore.matches(call.tool)) {
              return { allowed: true, scope: "project" };
            }
            const answer = normalizePermissionAnswer(await baseAsker.confirm(call));
            if (answer.allowed && answer.scope === "session") {
              permissions.grant(call.tool);
            }
            if (answer.allowed && answer.scope === "project") {
              await grantStore.grant(call.tool);
            }
            return answer;
          },
        };
  const agentsMd = await loadAgentsMd(opts.cwd, opts.kcodeHomeDir);
  // 运行环境块（对标 Claude Code <env> 注入）：模型不再猜 shell 方言/平台，避免补偿式重试
  const shell = await currentShellInfo();
  // B1 子代理定义：project > user，同名先见者胜；保留名不可覆盖
  const agents = await AgentLibrary.open(
    [
      { dir: join(opts.cwd, ".kcode", "agents"), source: "project" as const },
      { dir: join(opts.kcodeHomeDir, "agents"), source: "user" as const },
    ],
    opts.onNotice,
  );
  const customAgents = agents.list();
  if (customAgents.length > 0) {
    opts.onNotice?.(
      `已装载 ${customAgents.length} 个自定义子代理：${customAgents.map((a) => a.name).join("、")}`,
    );
  }
  const subagentLine = `- 大范围搜索/多文件调研/可独立的子任务用 task 工具派生子代理（隔离上下文，只回传结论，不占用本会话历史）；可用类型：general-purpose（通用）、explore（只读搜索）${customAgents.length > 0 ? `、${customAgents.map((a) => `${a.name}（${a.description}）`).join("、")}` : ""}`;
  const basePrompt = `${SYSTEM_PROMPT}
${subagentLine}

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
  // 父会话当前模型（setModel 后更新；task 子代理默认沿用）
  let currentModel = opts.model;
  // 权限模式与切换（plan_submit 批准后也要切回 default——先用占位，loop 创建后赋真身）
  let sessionMode: PermissionMode = "default";
  let applyMode: (mode: PermissionMode) => void = () => {};
  // B1 子代理：会话工具全集先成数组（task 不在其中——子代理不嵌套派生），再挂 task 工具
  const baseTools = [
    ...createSessionTools({
      sessionId,
      artifactsDir: join(opts.kcodeHomeDir, "cli", "artifacts", sessionId),
      onNotice: opts.onNotice,
      sink,
      prompt: opts.askUser,
    }),
    createSessionsTool({ sessionsDir: join(opts.kcodeHomeDir, "cli", "sessions") }),
    ...createWebTools(),
    ...mcpSessions.flatMap((s) => s.tools),
    ...pluginMcpSessions.flatMap((s) => s.tools),
  ];
  // B2 /rewind：写类工具执行前快照目标文件（bash 造成的改动无法快照——与 CC 检查点同边界）
  const checkpoints = new CheckpointStore(join(opts.kcodeHomeDir, "cli", "artifacts", "checkpoints", sessionId));
  const guardedTools = baseTools.map((t) => withFileCheckpoints(t, checkpoints, resolveInCtx));
  const taskTool = buildTaskTool({
    llmFactory: opts.llmFactory,
    currentModel: () => currentModel,
    cwd: opts.cwd,
    kcodeHomeDir: opts.kcodeHomeDir,
    baseTools: guardedTools,
    hooks,
    permissionFor: (kind) =>
      new RuleBasedPermissionEngine({ rules: kind === "readonly" ? READONLY_RULES : DEFAULT_RULES, fallback: "deny" }),
    asker,
    agents,
    envBlock: `<env>
OS=${process.platform} · shell=${shell.dialect} · cwd=${opts.cwd}
</env>`,
    onNotice: opts.onNotice,
  });
  const planSubmitTool = buildPlanSubmitTool({
    currentMode: () => sessionMode,
    planAsker: opts.planAsker,
    // 批准 = 钉固计划为跨压缩锚点（B3）+ 切回执行模式
    onApproved: (plan) => {
      loop.pinAnchor(`【已批准的执行计划——执行以本计划为准】
${plan}`);
      applyMode("default");
    },
  });
  const loop = new AgentLoop(
    {
      llm: initialLlm,
      tools: new InMemoryToolRegistry([...guardedTools, taskTool, planSubmitTool]),
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
      initialUsage: opts.resumeUsage,
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
  // applyMode 真身（plan_submit 批准后经占位闭包调用到这里的最终绑定）
  applyMode = (mode: PermissionMode) => {
    // 切入 plan 档清空会话级放行：只读姿态不被历史放行打穿
    if (mode === "plan") {
      permissions.clearGrants();
    }
    sessionMode = mode;
    permissions.set(
      new RuleBasedPermissionEngine({ rules: RULES_BY_MODE[mode], fallback: "deny" }),
    );
    loop.updateSystemPrompt(basePrompt + (mode === "plan" ? PLAN_MODE_SUFFIX : ""));
  };
  return {
    loop,
    sessionId,
    jsonlPath,
    abort: () => {
      activeAbort?.abort();
    },
    setMode: applyMode,
    setModel: async (model) => {
      const llm = await opts.llmFactory(model);
      currentModel = model;
      loop.updateModel(model, llm, new LlmSummarizer(llm, model));
    },
    listCommands: () => commands.list().map((c) => ({ name: c.name, source: c.source })),
    expandCommand: (name, args) => commands.expand(name, args),
    listSkills: () => skills.meta().map((s) => ({ name: s.name, description: s.description, source: "" })),
    skillBody: (name) => skills.body(name).catch(() => null),
    listPersistentGrants: () => grantStore.list(),
    clearPersistentGrants: () => grantStore.clear(),
    usageSummary: () => loop.getUsage(),
    listRewindPoints: async () => {
      const events = await loadSessionEvents(jsonlPath);
      const points: { eventIndex: number; preview: string; ts: number; fileChanges: number }[] = [];
      for (let i = 0; i < events.length; i++) {
        const event = events[i]!;
        if (event.type === "user_message") {
          points.push({
            eventIndex: i,
            preview: event.content.slice(0, 40),
            ts: event.ts,
            fileChanges: 0,
          });
        } else if (
          event.type === "tool_call" &&
          (event.tool === "write" || event.tool === "edit") &&
          points.length > 0 &&
          checkpoints.get(event.callId) !== undefined
        ) {
          points[points.length - 1]!.fileChanges++;
        }
      }
      return points;
    },
    rewind: async (eventIndex: number) => {
      if (activeAbort !== null) {
        throw new Error("运行中不能回退（等待本轮完成或 Esc 中断）");
      }
      const events = await loadSessionEvents(jsonlPath);
      const target = events[eventIndex];
      if (target === undefined || target.type !== "user_message") {
        throw new Error("回退点无效");
      }
      // 恢复该提问起的全部写/编辑前像（store 内部按逆序回滚）
      const callIds = events
        .slice(eventIndex)
        .filter(
          (e): e is Extract<(typeof events)[number], { type: "tool_call" }> =>
            e.type === "tool_call" && (e.tool === "write" || e.tool === "edit"),
        )
        .map((e) => e.callId)
        .filter((id) => checkpoints.get(id) !== undefined);
      const restoredFiles = await checkpoints.restore(callIds);
      loop.replaceHistory(rebuildHistory(events.slice(0, eventIndex)));
      opts.onNotice?.(`已回退：恢复 ${restoredFiles} 个文件 · 对话截断 ${events.length - eventIndex} 个事件`);
      return { restoredFiles, droppedEvents: events.length - eventIndex };
    },
    compactNow: async () => {
      if (activeAbort !== null) {
        throw new Error("运行中不能压缩（等待本轮完成或 Esc 中断）");
      }
      const result = await loop.compactNow();
      if (result === null) {
        return null;
      }
      opts.onEvent?.({
        v: 1,
        type: "compaction_summary",
        ts: Date.now(),
        sessionId,
        summary: result.summary,
        dropped: result.dropped,
      });
      return { dropped: result.dropped, summaryChars: result.summary.length };
    },
    runBash: async (command, timeoutMs) => {
      const bash = createBashTool({
        sessionId: `${sessionId}-user`,
        artifactsDir: join(opts.kcodeHomeDir, "cli", "artifacts", `${sessionId}-user`),
        onNotice: opts.onNotice,
      });
      const started = Date.now();
      const result = await bash.execute(
        { command, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
        { sessionId, cwd: opts.cwd },
      );
      return {
        ok: result.ok,
        output: result.output,
        ...(result.error !== undefined ? { error: result.error } : {}),
        durationMs: Date.now() - started,
      };
    },
    contextStats: () => loop.contextStats(),
    close: async () => {
      await Promise.all([...mcpSessions, ...pluginMcpSessions].map((s) => s.close()));
      await checkpoints.cleanup();
    },
  };
}

/** 解析续接来源（latest / id 前缀 / 精确 id），返回种子历史与历史累计用量；找不到返回 null */
export async function resolveResumeHistory(
  kcodeHomeDir: string,
  resumeFrom: string,
): Promise<{ messages: ChatMessage[]; usage: SessionUsage } | null> {
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
  const events = await loadSessionEvents(target.filePath);
  const usage: SessionUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  for (const event of events) {
    if (event.type === "session_end" && event.usage !== undefined) {
      usage.inputTokens += event.usage.inputTokens;
      usage.outputTokens += event.usage.outputTokens;
      usage.calls += event.usage.calls;
    }
  }
  return { messages: rebuildHistory(events), usage };
}

/** 把项目写入受信任清单（幂等） */
export function trustProject(cwd: string, kcodeHomeDir: string): Promise<void> {
  return trustProjectOnFile(cwd, join(kcodeHomeDir, "trusted-projects.json"));
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ChatMessage,
  LLMProvider,
  PermissionAsker,
  PermissionMode,
  SessionEvent,
  SessionSink,
  Tool,
  ToolCallRef,
  UserPromptPort,
} from "@kcode/contracts";
import { normalizePermissionAnswer } from "@kcode/contracts";
import { AgentLoop, InMemoryToolRegistry, MemoryAudit, type SessionUsage } from "@kcode/core";
import {
  AgentLibrary,
  CommandLibrary,
  FsSkillLibrary,
  ModePermissionEngine,
  MutablePermissionEngine,
  ProcessHookRunner,
  ProjectGrantStore,
  buildExtensionRoots,
  loadHookConfigs,
} from "@kcode/extensions";
import { SessionRunner, RuntimeCommandQueue, type QueuedCommand, JsonlSessionSink, createSessionsTool, loadSessionEvents, effectiveEvents } from "@kcode/runtime";
import { LlmSummarizer } from "@kcode/platform";
import { newId, workspaceKey } from "@kcode/shared";
import { connectMcpServers, createSessionTools, createWebTools, currentShellInfo, resolveInCtx } from "@kcode/tools";
import { buildTaskTool } from "./subagent.js";
import { buildPlanSubmitTool, type PlanVerdict } from "./plan-submit.js";
import { CheckpointStore, withFileCheckpoints } from "./checkpoints.js";
import { rewindTo } from "./rewind.js";
import { runUserBash } from "./user-bash.js";
import { PLAN_MODE_SUFFIX, SYSTEM_PROMPT } from "./prompt.js";

export interface ComposedSession {
  loop: AgentLoop;
  runner: SessionRunner;
  /** 运行中输入排队（N2-2）：busy 时入队而非拒绝；中断清空；单 reservation 防双 turn */
  commandQueue: RuntimeCommandQueue;
  sessionId: string;
  jsonlPath: string;
  /** 中断当前运行（Esc abort）：流式立即停止、未开始的工具调用取消 */
  abort(runId?: string): boolean;
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
  /** /mcp：接入状态（含失败项） */
  mcpInfo(): { servers: { name: string; transport: string; tools: number; ok: boolean }[] };
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
  /** 计划批准交互（plan_submit 工具，B2）：调用方注入，批准/修订/放弃三态 */
  planAsker?: { ask(plan: string): Promise<PlanVerdict> };
  /** 排队变化通知（N2-2）：入队/出队/清空时回调快照，界面镜像排队状态 */
  onQueueChange?: (items: readonly QueuedCommand[]) => void;
  /** 初始权限档（--mode）：省略即 default；与运行中 /mode 切换走同一条 applyMode 路径 */
  initialMode?: PermissionMode;
  /** 组装期剔除的工具名（--disallowed-tools）：作用于含 MCP/插件/task/plan_submit 的全集；未知名抛错 */
  disallowedTools?: string[];
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
 * 会话组装（单进程唯一组装点）：工具、权限、钩子、技能、命令、
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
  const permissions = new MutablePermissionEngine(new ModePermissionEngine("default"));
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

  // 插件装载与技能/命令根构造（N3C-3 单一事实源）：与 skills list / commands list 子命令同源，
  // 停用（state.json）在此统一过滤——会话组装与 CLI 盘点永远看到同一份生效集
  const extensionRoots = await buildExtensionRoots({ cwd: opts.cwd, kcodeHomeDir: opts.kcodeHomeDir });
  const plugins = extensionRoots.plugins;

  const skills = await FsSkillLibrary.open(extensionRoots.skillRoots, opts.onNotice);
  const hookConfigs = await loadHookConfigs({
    userDir: opts.kcodeHomeDir,
    projectDir: opts.cwd,
    trustFile: join(opts.kcodeHomeDir, "trusted-projects.json"),
    onWarn: opts.onNotice,
  });
  const hooks = new ProcessHookRunner(hookConfigs, { sessionId, onWarn: opts.onNotice });
  const commands = await CommandLibrary.open(extensionRoots.commandRoots, opts.onNotice);
  const mcpConfigs = await loadMcpConfigs(opts.kcodeHomeDir);
  const mcpSessions = await connectMcpServers(mcpConfigs, {
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
  const checkpoints = await CheckpointStore.open(join(opts.kcodeHomeDir, "cli", "artifacts", "checkpoints", sessionId));
  const guardedTools = baseTools.map((t) => withFileCheckpoints(t, checkpoints, resolveInCtx));
  // 组装期剔除（--disallowed-tools）：归一化一次，子代理与主注册表共用同一剔除集
  const disallowedSet = normalizeDisallowedTools(opts.disallowedTools);
  // 子代理继承剔除：被点名剔除的工具在 task 派生的隔离上下文里同样不可见
  const subagentBaseTools =
    disallowedSet === undefined ? guardedTools : guardedTools.filter((t) => !disallowedSet.has(t.definition.name));
  const taskTool = buildTaskTool({
    llmFactory: opts.llmFactory,
    currentModel: () => currentModel,
    cwd: opts.cwd,
    kcodeHomeDir: opts.kcodeHomeDir,
    baseTools: subagentBaseTools,
    hooks,
    // 只读子代理走 plan 档语义（声明驱动的只读放行面）；其余同默认档
    permissionFor: (kind) => new ModePermissionEngine(kind === "readonly" ? "plan" : "default"),
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
      // 未知名校验对**全集**（guardedTools 含 write/edit 等）而非剔除后的子代理视图，
      // 否则被点名剔除的工具自身会被误报为"未知"
      tools: new InMemoryToolRegistry(
        applyDisallowedTools([...guardedTools, taskTool, planSubmitTool], disallowedSet),
      ),
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
      workspaceKey: workspaceKey(opts.cwd),
      agentsMd,
      initialHistory: opts.resumeFrom,
      initialUsage: opts.resumeUsage,
      maxTurns: 24,
    },
  );
  const runner = new SessionRunner();
  const commandQueue = new RuntimeCommandQueue(opts.onQueueChange);
  const rawLoopRun = loop.run.bind(loop);
  loop.run = (input, runOpts = {}) => {
    try {
      return runner.start((signal) => rawLoopRun(input, {
        ...runOpts, signal: runOpts.signal === undefined ? signal : AbortSignal.any([signal, runOpts.signal]),
      }), runOpts.runId).result;
    } catch (err) { return Promise.reject(err); }
  };
  // applyMode 真身（plan_submit 批准后经占位闭包调用到这里的最终绑定）
  applyMode = (mode: PermissionMode) => {
    // 切入 plan 档清空会话级放行：只读姿态不被历史放行打穿
    if (mode === "plan") {
      permissions.clearGrants();
    }
    sessionMode = mode;
    permissions.set(new ModePermissionEngine(mode));
    loop.updateSystemPrompt(basePrompt + (mode === "plan" ? PLAN_MODE_SUFFIX : ""));
  };
  // 初始权限档（--mode）：走与运行中切换完全相同的路径，杜绝"开局档位语义不同"的分叉
  if (opts.initialMode !== undefined) {
    applyMode(opts.initialMode);
  }
  return {
    loop,
    runner,
    commandQueue,
    sessionId,
    jsonlPath,
    abort: (runId) => runner.abort(runId),
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
      // 只列**有效前缀**内的提问：已回退掉的轮次不应再出现在回退点清单里
      const events = effectiveEvents(await loadSessionEvents(jsonlPath));
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
    rewind: (eventIndex) =>
      rewindTo({
        eventIndex,
        jsonlPath,
        sessionId,
        busy: runner.busy,
        checkpoints,
        sink,
        loop,
        onNotice: opts.onNotice,
      }),
    compactNow: async () => {
      if (runner.busy) {
        throw new Error("运行中不能压缩（等待本轮完成或 Esc 中断）");
      }
      const result = await loop.compactNow();
      if (result === null) {
        return null;
      }
      // 手动压缩与自动压缩走同一条落盘路径：经 sink 写 JSONL，重启后可回放，避免摘要只留在界面
      await sink.append({
        v: 1,
        type: "compaction_summary",
        ts: Date.now(),
        sessionId,
        summary: result.summary,
        dropped: result.dropped,
        covered: result.covered,
      });
      return { dropped: result.dropped, summaryChars: result.summary.length };
    },
    mcpInfo: () => {
      const all = [...mcpConfigs, ...pluginMcpConfigs];
      const connected = new Map([...mcpSessions, ...pluginMcpSessions].map((x) => [x.name, x]));
      return {
        servers: all.map((cfg) => {
          const session = connected.get(cfg.name);
          return {
            name: cfg.name,
            transport: cfg.transport,
            tools: session?.tools.length ?? 0,
            ok: session !== undefined,
          };
        }),
      };
    },
    runBash: (command, timeoutMs) =>
      runUserBash(command, timeoutMs, {
        sessionId,
        kcodeHomeDir: opts.kcodeHomeDir,
        cwd: opts.cwd,
        onNotice: opts.onNotice,
      }),
    contextStats: () => loop.contextStats(),
    close: async () => {
      runner.abort();
      await Promise.all([...mcpSessions, ...pluginMcpSessions].map((s) => s.close()));
      // 检查点目录不再随关闭清理：保留清单与前像，重启后可继续列出/回退
    },
  };
}

/** 归一化 --disallowed-tools 输入（逗号/空白分隔可混用）；空输入返回 undefined（零成本直通） */
function normalizeDisallowedTools(names: string[] | undefined): Set<string> | undefined {
  if (names === undefined) {
    return undefined;
  }
  const set = new Set(names.flatMap((s) => s.split(/[\s,]+/)).filter((s) => s !== ""));
  return set.size > 0 ? set : undefined;
}

/** 组装期剔除工具：未知名抛错并列出全集——拼错名导致"以为剔除了"比当场报错更糟 */
function applyDisallowedTools(tools: Tool[], disallowed: Set<string> | undefined): Tool[] {
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

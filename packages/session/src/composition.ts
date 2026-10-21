import { join } from "node:path";
import type {
  ChatMessage,
  FileReadRecord,
  LLMProvider,
  McpServerConfig,
  PermissionAsker,
  PermissionEngine,
  PermissionMode,
  SessionEvent,
  SessionSink,
  TodoItem,
  Tool,
  ToolCallRef,
  UserPromptPort,
} from "@kcode/contracts";
import { normalizePermissionAnswer } from "@kcode/contracts";
import { AgentLoop, InMemoryToolRegistry, type AuditSink, type SessionUsage } from "@kcode/core";
import {
  AgentLibrary,
  CommandLibrary,
  FsSkillLibrary,
  ModePermissionEngine,
  MutablePermissionEngine,
  SensitivePathPermissionEngine,
  ProcessHookRunner,
  PluginPermissionEngine,
  parsePluginPermissions,
  pluginMcpConfigs as pluginMcpServerConfigs,
  type SourcedHookConfig,
  ProjectGrantStore,
  grantSubject,
  suggestGrant,
  buildExtensionRoots,
  isProjectTrusted,
  loadHookConfigs,
  loadPolicy,
  PolicyPermissionEngine,
} from "@kcode/extensions";
import { SessionRunner, RuntimeCommandQueue, type QueuedCommand, JsonlSessionSink, createSessionsTool, loadSessionEvents, effectiveEvents } from "@kcode/runtime";
import { LlmSummarizer } from "@kcode/platform";
import { LazyLlmProvider } from "./lazy-llm.js";
import { newId, workspaceKey } from "@kcode/shared";
import { connectMcpServers, createSessionTools, createWebTools, currentShellInfo, resolveInCtx, BackgroundTaskRegistry } from "@kcode/tools";
import { buildTaskTool } from "./subagent.js";
import { buildPlanSubmitTool, type PlanVerdict } from "./plan-submit.js";
import { buildSkillTool } from "./skill-tool.js";
import { buildSendMessageTool } from "./agent-messaging.js";
import { SubagentRegistry } from "./subagent-registry.js";
import { loadMcpConfigs, loadAgentsMd, normalizeDisallowedTools, applyDisallowedTools } from "./composition-helpers.js";
import { CheckpointStore, listCheckpointChanges, withFileCheckpoints } from "./checkpoints.js";
import { rewindTo } from "./rewind.js";
import { runUserBash } from "./user-bash.js";
import { openFileAuditSink } from "./audit.js";
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
  listCommands(): {
    name: string;
    source: "project" | "user";
    description?: string;
    argumentHint?: string;
    allowedTools?: string[];
    model?: string;
  }[];
  expandCommand(name: string, args: string): Promise<string | null>;
  listSkills(): {
    name: string;
    description: string;
    source: string;
    allowedTools?: string[];
    manualOnly?: boolean;
  }[];
  skillBody(name: string): Promise<string | null>;
  /** 本项目持久放行清单（/permissions） */
  listPersistentGrants(): Promise<string[]>;
  /** 清空本项目持久放行，返回清除条数（/permissions） */
  clearPersistentGrants(): Promise<number>;
  /** 3-29：本会话审计日志路径（/audit 读取） */
  auditPath(): string;
  /** 会话累计用量（含 resume 种子；/cost） */
  usageSummary(): SessionUsage;
  /** D2-05：本会话写/编辑产生的 changed files（相对检查点前像的真实 diff） */
  listChanges(): Promise<
    Array<{ path: string; diff: string; callIds: string[]; existed: boolean }>
  >;
  /** 按文件路径回退到本会话首次修改前；paths 省略 = 全部 */
  revertChanges(paths?: string[]): Promise<{ restoredFiles: number }>;
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
  /** 单个已连接 MCP 服务器的工具名清单（N3I-7 /mcp tools；未连接返回 null） */
  mcpToolNames(name: string): string[] | null;
  /** 已装载 hooks（N3I-7 /hooks；带用户/项目来源标） */
  hooksInfo(): {
    source: "user" | "project" | "plugin";
    event: string;
    command: string;
    matcher?: string;
    plugin?: string;
    failClosed?: boolean;
  }[];
  /** 后台任务清单（N3C-4③）：bash 工具注册表的会话级视图（任务面板轮询源） */
  backgroundTasks(): { id: string; command: string; status: "running" | "done" | "failed"; exitCode?: number; logPath: string; startedAt: number; notified?: boolean }[];
  /** D2-07：终止运行中的后台任务；返回是否真的发出终止信号 */
  stopBackgroundTask(id: string): boolean;
  /** /context 上下文占用 */
  contextStats(): {
    model: string;
    contextWindow: number;
    windowKnown: boolean;
    historyTokens: number;
    historyBudget: number;
    systemTokens: number;
    pinnedAnchor: boolean;
    sessionUsage: SessionUsage;
    sessionBudgetTokens?: number;
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
  /** 会话 ID（resume 续接时传原 ID——新 JSONL 同文件追加，侧栏/重放一致；缺省 newId） */
  sessionId?: string;
  /** 单轮工具循环上限（默认 24） */
  maxTurns?: number;
  /** 临时会话：不落 JSONL（事件仍经 onEvent 给调用方） */
  ephemeral?: boolean;
  /** 续接的历史累计用量（旧会话 session_end 求和；/cost 跨续接可见） */
  resumeUsage?: SessionUsage;
  /** 3-13：续接恢复的最新任务清单 */
  resumeTodos?: TodoItem[];
  /** 3-13：续接恢复的子代理用量分项 */
  resumeSubagents?: { count: number; inputTokens: number; outputTokens: number };
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
  /** 空闲压缩阈值毫秒（N3E-6，测试注入用）；默认 60min */
  idleCompactMs?: number;
  /** 会话 token 预算（N3I-8）：透传 AgentLoop；到顶经 onBudgetLimit 问询 */
  sessionBudgetTokens?: number;
  onBudgetLimit?: (used: { inputTokens: number; outputTokens: number; calls: number }, max: number) => Promise<boolean>;
  /** 组装期剔除的工具名（--disallowed-tools）：作用于含 MCP/插件/task/plan_submit 的全集；未知名抛错 */
  disallowedTools?: string[];
}



/**
 * 会话组装（单进程唯一组装点）：工具、权限、钩子、技能、命令、
 * MCP、记忆与摘要器在此聚合，外部只传入模型与回调。
 */
export async function composeSession(opts: ComposeSessionOptions): Promise<ComposedSession> {
  const sessionId = opts.sessionId ?? newId("sess");
  const jsonlPath = join(opts.kcodeHomeDir, "cli", "sessions", `${sessionId}.jsonl`);
  // 2-12 --ephemeral：事件仍交给调用方，但不创建 JSONL（CI/临时任务不产垃圾）
  const disk = opts.ephemeral === true ? null : await JsonlSessionSink.open(jsonlPath);
  // 3-13：子代理用量从任意事件流来源累计（子代理 parentSink 绕过 sinkWithIdle）
  const subagentUsage = { ...(opts.resumeSubagents ?? { count: 0, inputTokens: 0, outputTokens: 0 }) };
  const sink: SessionSink = {
    append: async (event) => {
      if (event.type === "subagent_stopped") {
        subagentUsage.count += 1;
        subagentUsage.inputTokens += event.usage.inputTokens;
        subagentUsage.outputTokens += event.usage.outputTokens;
      }
      opts.onEvent?.(event);
      await disk?.append(event);
    },
  };
  // 空闲计时锚点（N3E-6）：任一事件活动即刷新；下一次输入距此超阈值先压缩
  let lastEventAt = Date.now();
  // 3-13：todo 状态从工具回调进入会话，loop 每轮读取（压缩/续接后仍在）
  let todoState: TodoItem[] = opts.resumeTodos ?? [];
  const sinkWithIdle: SessionSink = {
    append: async (event) => {
      lastEventAt = Date.now();
      await sink.append(event);
    },
  };
  // 2-14：敏感路径保护在会话级放行之外——grant 不能把 .env/.ssh 放行打穿
  let sessionMode: PermissionMode = "default";
  // 3-29：审计独立落盘（工具/裁决/scope/耗时/cwd/权限档）；MemoryAudit 仅测试用
  const auditFile = await openFileAuditSink(
    join(opts.kcodeHomeDir, "cli", "audit", `${sessionId}.jsonl`),
    opts.onNotice,
  );
  const auditSink: AuditSink = (record) =>
    auditFile.sink({
      ...record,
      cwd: opts.cwd,
      mode: sessionMode,
      ...(record.parentSessionId !== undefined ? { parentSessionId: record.parentSessionId } : {}),
    });
  const mutablePermissions = new MutablePermissionEngine(new ModePermissionEngine("default"));
  const basePermissions = new SensitivePathPermissionEngine(mutablePermissions, () => sessionMode);
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
            // N3I-5：参数级匹配——bash 按命令主体、edit/write 按路径主体命中模式
            if (await grantStore.matches(call.tool, grantSubject(call.args))) {
              return { allowed: true, scope: "project" };
            }
            const answer = normalizePermissionAnswer(await baseAsker.confirm(call));
            if (answer.allowed && answer.scope === "session") {
              // 2-21：会话级也参数级化（bash 子命令前缀 / edit·write 目录前缀）
              mutablePermissions.grant(suggestGrant(call) ?? call.tool);
            }
            if (answer.allowed && answer.scope === "project") {
              // 参数级建议规则（bash 子命令前缀 / edit·write 目录前缀）；无建议回落整工具名
              await grantStore.grant(suggestGrant(call) ?? call.tool);
            }
            return answer;
          },
        };
  // 2-17 / P0-0：项目扩展（skills/agents/commands）、hooks、AGENTS.md 共用同一 trust 门控
  const projectTrusted = await isProjectTrusted(
    opts.cwd,
    join(opts.kcodeHomeDir, "trusted-projects.json"),
  );
  // 4-02：项目策略文件（.kcode/policy.json）。deny/ask 在未信任项目也生效；
  // allow 只在 /trust 后生效（项目文件不能自授放行）。解析失败 fail-closed。
  const policy = await loadPolicy(opts.cwd, projectTrusted);
  if (policy.exists) {
    if (policy.errors.length > 0) {
      opts.onNotice?.(
        `项目策略无效（${policy.path}）：${policy.errors.join("；")}——已 fail-closed，全部工具拒绝`,
      );
    } else if (policy.rules.length > 0) {
      opts.onNotice?.(
        `已加载项目策略 ${policy.rules.length} 条（${policy.path}）——deny/ask 优先于当前权限档`,
      );
    }
    if (policy.ignoredAllow > 0) {
      opts.onNotice?.(
        `项目策略有 ${policy.ignoredAllow} 条 allow 未生效：项目未受信任（/trust 后新会话生效）`,
      );
    }
  }
  const withPolicy = (engine: PermissionEngine): PermissionEngine =>
    new PolicyPermissionEngine(engine, policy);
  // `!命令` 是用户显式直执行（不询问权限），但策略 deny 仍应拦住“永不执行”的命令。
  const allowEngineForPolicy: PermissionEngine = { decide: () => "allow" };
  const policyOnly = new PolicyPermissionEngine(allowEngineForPolicy, policy);
  const runPolicyBash = async (
    command: string,
    timeoutMs: number | undefined,
    optsForBash: { sessionId: string; kcodeHomeDir: string; cwd: string; onNotice?: (message: string) => void },
  ): Promise<{ ok: boolean; output: string; error?: string; durationMs: number }> => {
    const verdict = await policyOnly.decide(
      { name: "bash", description: "", parameters: {}, readOnly: false },
      { command },
    );
    if (verdict === "deny") {
      return { ok: false, output: "", error: "项目策略拒绝该命令（policy deny）", durationMs: 0 };
    }
    return runUserBash(command, timeoutMs, optsForBash);
  };
  const agentsMd = await loadAgentsMd(opts.cwd, opts.kcodeHomeDir, { includeProject: projectTrusted });
  // 运行环境块（对标 Claude Code <env> 注入）：模型不再猜 shell 方言/平台，避免补偿式重试
  const shell = await currentShellInfo();

  // 插件装载与技能/命令根构造（N3C-3 单一事实源）：与 skills list / commands list 子命令同源，
  // 停用（state.json）与加载期完整性校验（N3-5）在此统一收口——
  // 会话组装与 CLI 盘点永远看到同一份"已验证且启用"的生效集
  const extensionRoots = await buildExtensionRoots({
    cwd: opts.cwd,
    kcodeHomeDir: opts.kcodeHomeDir,
    trusted: projectTrusted,
    onWarn: opts.onNotice,
  });
  if (!projectTrusted) {
    opts.onNotice?.(
      "项目未被信任：AGENTS.md、.kcode/skills、.kcode/agents、.kcode/commands 未装载（输入 /trust 信任本项目后新会话生效）",
    );
  }
  const plugins = extensionRoots.plugins;

  // B1 子代理定义：project > user > plugin，同名先见者胜；保留名不可覆盖
  const agents = await AgentLibrary.open(
    [
      ...(projectTrusted
        ? [{ dir: join(opts.cwd, ".kcode", "agents"), source: "project" as const }]
        : []),
      { dir: join(opts.kcodeHomeDir, "agents"), source: "user" as const },
      // 3-19：插件声明了 agents 才装载其 agents/ 目录（清单仍是同意边界）
      ...plugins
        .filter((p) => p.manifest.agents.length > 0)
        .map((p) => ({ dir: join(p.installPath, "agents"), source: "plugin" as const })),
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

  // 3-16：插件权限只允许收紧（ask/deny），多插件冲突 deny 优先；包在既有引擎外
  const pluginPermissionRules = new Map<string, "ask" | "deny">();
  for (const plugin of plugins) {
    for (const [tool, rule] of parsePluginPermissions(plugin.manifest.permissions).rules) {
      pluginPermissionRules.set(
        tool,
        pluginPermissionRules.get(tool) === "deny" || rule === "deny" ? "deny" : "ask",
      );
    }
  }
  const withPluginRules = (engine: PermissionEngine): PermissionEngine =>
    pluginPermissionRules.size > 0 ? new PluginPermissionEngine(engine, pluginPermissionRules) : engine;
  // 插件规则在外层：插件 deny 不能被项目策略 allow 打穿；策略在内层：可覆盖会话 grant。
  const permissions = withPluginRules(withPolicy(basePermissions));

  const skills = await FsSkillLibrary.open(extensionRoots.skillRoots, opts.onNotice);
  const baseHookConfigs = await loadHookConfigs({
    userDir: opts.kcodeHomeDir,
    projectDir: opts.cwd,
    trustFile: join(opts.kcodeHomeDir, "trusted-projects.json"),
    onWarn: opts.onNotice,
  });
  // 3-16：插件 manifest.hooks 进同一 runner（source=plugin；cwd 固定为插件安装目录）
  const pluginHookConfigs: SourcedHookConfig[] = plugins.flatMap((plugin) =>
    plugin.manifest.hooks.map((hook) => ({
      event: hook.event,
      command: hook.command,
      cwd: plugin.installPath,
      source: "plugin" as const,
      plugin: plugin.manifest.name,
      ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
      ...(hook.timeoutMs !== undefined ? { timeoutMs: hook.timeoutMs } : {}),
      ...(hook.failClosed !== undefined ? { failClosed: hook.failClosed } : {}),
    })),
  );
  const hookConfigs = [...baseHookConfigs, ...pluginHookConfigs];
  const hooks = new ProcessHookRunner(hookConfigs, { sessionId, onWarn: opts.onNotice });
  const commands = await CommandLibrary.open(extensionRoots.commandRoots, opts.onNotice);
  const mcpConfigs = await loadMcpConfigs(opts.kcodeHomeDir, {
    projectDir: opts.cwd,
    trusted: projectTrusted,
    ...(opts.onNotice !== undefined ? { onWarn: opts.onNotice } : {}),
  });
  const mcpSessions = await connectMcpServers(mcpConfigs, {
    onWarn: opts.onNotice,
  });
  // 3-16：按 transport 分流（stdio 用 command/args/env；http/sse 用 url），不再一律强转 stdio
  const pluginMcpConfigs: McpServerConfig[] = [];
  for (const plugin of plugins) {
    const built = pluginMcpServerConfigs(plugin.manifest);
    for (const error of built.errors) {
      opts.onNotice?.(`插件 ${plugin.manifest.name} 的 MCP 声明被跳过：${error}`);
    }
    pluginMcpConfigs.push(...built.configs);
  }
  const pluginMcpSessions = await connectMcpServers(pluginMcpConfigs, { onWarn: opts.onNotice });
  if (plugins.length > 0) {
    opts.onNotice?.(`已装载 ${plugins.length} 个插件：${plugins.map((p) => `${p.manifest.name}@${p.manifest.version}`).join("、")}`);
  }
  // 2-02：compose 阶段不解析模型——没有 key/配置也能先把会话装起来进 TUI
  const initialLlm = new LazyLlmProvider(() => opts.llmFactory(opts.model));
  // 父会话当前模型（setModel 后更新；task 子代理默认沿用）
  let currentModel = opts.model;
  // 权限模式与切换（plan_submit 批准后也要切回 default——先用占位，loop 创建后赋真身）
  let applyMode: (mode: PermissionMode) => void = () => {};
  // B1 子代理：会话工具全集先成数组（task 不在其中——子代理不嵌套派生），再挂 task 工具
  // 后台任务注册表在会话级创建并注入 bash 工具（N3C-4③）：句柄/面板与工具共享同一份事实
  const bashTasks = new BackgroundTaskRegistry();
  // 后台子代理连杀登记（N3D-1）：Esc 中断父时一并终止后台子代理（单进程语义，不抄 detachParent）
  const backgroundKills = new Set<() => void>();
  const baseTools = [
    ...createSessionTools({
      sessionId,
      artifactsDir: join(opts.kcodeHomeDir, "cli", "artifacts", sessionId),
      onNotice: opts.onNotice,
      sink,
      prompt: opts.askUser,
      registry: bashTasks,
      onTodoUpdate: (todos) => {
        todoState = todos;
      },
    }),
    createSessionsTool({ sessionsDir: join(opts.kcodeHomeDir, "cli", "sessions") }),
    // Skill 显式工具：模型按名读技能正文（渐进加载的显式通道，与自动触发/手动 /skill 共存）
    buildSkillTool({ skills, sink, sessionId }),
    ...createWebTools(),
    ...mcpSessions.flatMap((s) => s.tools),
    ...pluginMcpSessions.flatMap((s) => s.tools),
  ];
  // B2 /rewind：写类工具执行前快照目标文件（bash 造成的改动无法快照——与 CC 检查点同边界）
  const checkpoints = await CheckpointStore.open(join(opts.kcodeHomeDir, "cli", "artifacts", "checkpoints", sessionId));
  // 3-09：会话级已读文件表（read 记录，write/edit 与子代理共享校验）
  const readFiles = new Map<string, FileReadRecord>();
  const guardedTools = baseTools.map((t) => withFileCheckpoints(t, checkpoints, resolveInCtx));
  // 子代理句柄注册表（N3D-2）：SendMessage 寻址——只进父工具集，不进 baseTools
  //（子代理之间不可互发，对齐 zcode 的 includeAgent 门控）
  const agentRegistry = new SubagentRegistry();
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
    readFiles,
    hooks,
    audit: auditSink,
    // 3-19：子代理权限档由声明决定（plan/default/acceptEdits）；插件限制规则继续叠加
    permissionFor: (mode) =>
      withPluginRules(withPolicy(new SensitivePathPermissionEngine(new ModePermissionEngine(mode), () => mode))),
    parentMode: () => sessionMode,
    asker,
    agents,
    envBlock: `<env>
OS=${process.platform} · shell=${shell.dialect} · cwd=${opts.cwd}
</env>`,
    onNotice: opts.onNotice,
    /* N3D-1 异步子代理接线 */
    parentSessionId: sessionId,
    registry: bashTasks,
    parentSink: sink,
    askUser: opts.askUser,
    // 完成通知注入：父忙=入队（既有 drain 语义），父空闲=直接开新 turn（notify 只在完成后调用，
    // 此时 loop/runner 均已初始化——闭包捕获后置绑定的 const）
    notify: (text) => {
      if (runner.busy) {
        commandQueue.enqueue(text);
      } else {
        void loop.run(text).catch(() => undefined);
      }
    },
    trackBackground: (kill) => {
      backgroundKills.add(kill);
      return () => backgroundKills.delete(kill);
    },
    agentRegistry,
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
  // SendMessage（N3D-2）：父会话专属工具（两态投递），随主注册表装配
  const sendMessageTool = buildSendMessageTool({ registry: agentRegistry });
  const loop = new AgentLoop(
    {
      llm: initialLlm,
      // 未知名校验对**全集**（guardedTools 含 write/edit 等）而非剔除后的子代理视图，
      // 否则被点名剔除的工具自身会被误报为"未知"
      tools: new InMemoryToolRegistry(
        applyDisallowedTools([...guardedTools, taskTool, planSubmitTool, sendMessageTool], disallowedSet),
      ),
      permissions,
      hooks,
      sink: sinkWithIdle,
      audit: auditSink,
      asker,
      onDelta: opts.onDelta,
      onReasoning: opts.onReasoning,
      skills,
      todos: () => todoState,
      summarizer: new LlmSummarizer(initialLlm, opts.model),
    },
    {
      sessionId,
      model: opts.model,
      systemPrompt: basePrompt,
      cwd: opts.cwd,
      workspaceKey: workspaceKey(opts.cwd),
      readFiles,
      onToolProgress: (event) => opts.onEvent?.(event),
      agentsMd,
      initialHistory: opts.resumeFrom,
      initialUsage: opts.resumeUsage,
      maxTurns: opts.maxTurns ?? 24,
      sessionBudgetTokens: opts.sessionBudgetTokens,
      onBudgetLimit: opts.onBudgetLimit,
    },
  );
  const runner = new SessionRunner();
  const commandQueue = new RuntimeCommandQueue(opts.onQueueChange);
  const rawLoopRun = loop.run.bind(loop);
  /** 手动/空闲压缩共用落盘路径：原始 compactNow + compaction_summary 经 sink 写 JSONL（N0-1） */
  const persistedCompact = async (): Promise<{ dropped: number; summaryChars: number } | null> => {
    if (runner.busy) {
      throw new Error("运行中不能压缩（等待本轮完成或 Esc 中断）");
    }
    const result = await loop.compactNow();
    if (result === null) {
      return null;
    }
    await sinkWithIdle.append({
      v: 1,
      type: "compaction_summary",
      ts: Date.now(),
      sessionId,
      summary: result.summary,
      dropped: result.dropped,
      covered: result.covered,
    });
    return { dropped: result.dropped, summaryChars: result.summary.length };
  };
  const idleCompactMs = opts.idleCompactMs ?? 60 * 60_000;
  loop.run = async (input, runOpts = {}) => {
    // N3E-6：挂机超阈值（默认 60min）后，下一次输入先压缩——旧上下文大概率已冷，
    // 与 zcode 的 idle 微压缩同语义（kcode 用已有 compactNow 路径，落盘/回放语义不变）
    if (Date.now() - lastEventAt > idleCompactMs) {
      await persistedCompact().catch(() => null);
    }
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
      mutablePermissions.clearGrants();
    }
    sessionMode = mode;
    mutablePermissions.set(new ModePermissionEngine(mode));
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
    abort: (runId) => {
      // N3D-1：中断连杀后台子代理（与父同生共死——单进程语义）
      for (const kill of [...backgroundKills]) {
        kill();
      }
      return runner.abort(runId);
    },
    setMode: applyMode,
    setModel: async (model) => {
      // 同样延迟解析：/model 切换后第一次请求才校验 key/端点，允许先切模型再登录
      const llm = new LazyLlmProvider(() => opts.llmFactory(model));
      currentModel = model;
      loop.updateModel(model, llm, new LlmSummarizer(llm, model));
    },
    listCommands: () =>
      commands.list().map((c) => ({
        name: c.name,
        source: c.source,
        ...(c.description !== undefined ? { description: c.description } : {}),
        ...(c.argumentHint !== undefined ? { argumentHint: c.argumentHint } : {}),
        ...(c.allowedTools !== undefined ? { allowedTools: c.allowedTools } : {}),
        ...(c.model !== undefined ? { model: c.model } : {}),
      })),
    // 3-17：`!` 行经用户直执行通道（不问权限、独立 artifacts），输出回填模板
    expandCommand: (name, args) =>
      commands.expand(name, args, async (command) => {
        const result = await runPolicyBash(command, 30_000, {
          sessionId,
          kcodeHomeDir: opts.kcodeHomeDir,
          cwd: opts.cwd,
          ...(opts.onNotice !== undefined ? { onNotice: opts.onNotice } : {}),
        });
        return {
          ok: result.ok,
          output: result.output,
          ...(result.error !== undefined ? { error: result.error } : {}),
        };
      }),
    // 3-18：完整清单（含手动技能/来源/允许工具）；模型通道只看到 meta() 过滤后的集合
    listSkills: () =>
      skills.list().map((s) => ({
        name: s.name,
        description: s.description,
        source: s.source,
        ...(s.allowedTools !== undefined ? { allowedTools: s.allowedTools } : {}),
        manualOnly: s.manualOnly,
      })),
    // 用户 /skill 是显式手动通道：绕过 disable-model-invocation/第三方默认手动
    skillBody: (name) => skills.manualBody(name).catch(() => null),
    listPersistentGrants: () => grantStore.list(),
    clearPersistentGrants: () => grantStore.clear(),
    usageSummary: () => ({ ...loop.getUsage(), subagents: { ...subagentUsage } }),
    auditPath: () => auditFile.path,
    listChanges: () => listCheckpointChanges(checkpoints),
    revertChanges: async (paths) => {
      // 运行中回退会与写类工具竞态（半回滚 / 把正在写的内容覆盖掉）——与 host 侧同一守卫
      if (runner.busy) {
        throw new Error("运行中不能回退文件（等本轮完成或 Esc 中断）");
      }
      const selected = paths === undefined ? undefined : new Set(paths);
      const callIds = checkpoints
        .list()
        .filter((e) => selected === undefined || selected.has(e.path))
        .map((e) => e.callId);
      return { restoredFiles: await checkpoints.restore(callIds) };
    },
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
    compactNow: persistedCompact,
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
    mcpToolNames: (name) => {
      const session = [...mcpSessions, ...pluginMcpSessions].find((x) => x.name === name);
      return session === undefined ? null : session.tools.map((t) => t.definition.name);
    },
    hooksInfo: () =>
      hookConfigs.map((h) => ({
        source: h.source,
        event: h.event,
        command: h.command,
        ...(h.matcher !== undefined ? { matcher: h.matcher } : {}),
        ...(h.plugin !== undefined ? { plugin: h.plugin } : {}),
        failClosed: h.failClosed,
      })),
    runBash: (command, timeoutMs) =>
      runPolicyBash(command, timeoutMs, {
        sessionId,
        kcodeHomeDir: opts.kcodeHomeDir,
        cwd: opts.cwd,
        onNotice: opts.onNotice,
      }),
    backgroundTasks: () => bashTasks.list().map((t) => ({ ...t })),
    stopBackgroundTask: (id) => bashTasks.stop(id),
    contextStats: () => loop.contextStats(),
    close: async () => {
      // 退出顺序：先 abort/杀后台，再等当前 run 结算，最后关 MCP。
      // 反序会让进行中的工具在 MCP 关闭后报错，且后台 bash/子代理会变孤儿。
      runner.abort();
      for (const kill of [...backgroundKills]) {
        kill();
      }
      backgroundKills.clear();
      bashTasks.stopAll();
      await runner.drain(2_000);
      await Promise.allSettled([...mcpSessions, ...pluginMcpSessions].map((s) => s.close()));
      // 3-29：审计队列排空（最后几条工具记录不丢）
      await auditFile.close();
      // 检查点目录不再随关闭清理：保留清单与前像，重启后可继续列出/回退
    },
  };
}


